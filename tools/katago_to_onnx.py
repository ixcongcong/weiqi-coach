#!/usr/bin/env python3
"""把 KataGo 的 .bin.gz 网络（模型版本 8，g170 系列）转换成 ONNX，供网页里的 onnxruntime-web 离线使用。

用法: python katago_to_onnx.py 输入.bin.gz 输出.onnx [--fp16]

输入:  spatial [N,22,H,W]  global [N,19]    （H、W 可变，按实际棋盘大小，不需要 mask）
输出:  policy [N,H*W+1]（最后一个是停一手，未做 softmax）
       value  [N,3]  （赢 / 输 / 无结果 的 logits，站在下一手方的角度）
       score  [N,4]  （scoreMean、scoreStdev、lead、varTime 的原始值）
       ownership [N,H*W]（未做 tanh，站在下一手方的角度）
"""
import gzip
import struct
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def tok(self):
        d, p = self.d, self.p
        while d[p] in b' \t\r\n':
            p += 1
        q = p
        while d[q] not in b' \t\r\n':
            q += 1
        self.p = q
        return d[p:q].decode()

    def int(self):
        return int(self.tok())

    def float(self):
        return float(self.tok())

    def floats(self, n):
        k = self.d.index(b'@BIN@', self.p)
        assert k - self.p < 100
        start = k + 5
        arr = np.frombuffer(self.d[start:start + 4 * n], dtype='<f4').astype(np.float32).copy()
        self.p = start + 4 * n
        return arr


def read_conv(r):
    name = r.tok()
    ky, kx, ic, oc, dy, dx = (r.int() for _ in range(6))
    assert dy == 1 and dx == 1
    w = r.floats(ky * kx * ic * oc).reshape(ky, kx, ic, oc).transpose(3, 2, 0, 1).copy()
    return {'name': name, 'w': w}


def read_bn(r):
    name = r.tok()
    c = r.int()
    eps = r.float()
    has_scale = r.int()
    has_bias = r.int()
    mean = r.floats(c)
    var = r.floats(c)
    scale = r.floats(c) if has_scale else np.ones(c, np.float32)
    bias = r.floats(c) if has_bias else np.zeros(c, np.float32)
    s = scale / np.sqrt(var + eps)
    return {'name': name, 's': s.astype(np.float32), 'b': (bias - s * mean).astype(np.float32)}


def read_act(r, version):
    r.tok()
    if version >= 11:
        assert r.tok() == 'ACTIVATION_RELU'


def read_matmul(r):
    name = r.tok()
    ic, oc = r.int(), r.int()
    return {'name': name, 'w': r.floats(ic * oc).reshape(ic, oc)}


def read_matbias(r):
    name = r.tok()
    c = r.int()
    return {'name': name, 'b': r.floats(c)}


def parse(path):
    r = Reader(gzip.open(path).read())
    m = {'name': r.tok(), 'version': r.int()}
    v = m['version']
    assert v in (8, 9, 10), f'只支持模型版本 8~10，这个是 {v}'
    m['nin'], m['nglob'] = r.int(), r.int()
    t = {'name': r.tok(), 'nblocks': r.int(), 'c': r.int(), 'mid': r.int(), 'reg': r.int(), 'dil': r.int(), 'gp': r.int()}
    t['initConv'] = read_conv(r)
    t['initMatMul'] = read_matmul(r)
    blocks = []
    for _ in range(t['nblocks']):
        kind = r.tok()
        b = {'kind': kind, 'name': r.tok()}
        b['preBN'] = read_bn(r)
        read_act(r, v)
        b['regConv'] = read_conv(r)
        if kind == 'gpool_block':
            b['gpConv'] = read_conv(r)
            b['gpBN'] = read_bn(r)
            read_act(r, v)
            b['gpMul'] = read_matmul(r)
        else:
            assert kind == 'ordinary_block', kind
        b['midBN'] = read_bn(r)
        read_act(r, v)
        b['finalConv'] = read_conv(r)
        blocks.append(b)
    t['blocks'] = blocks
    t['tipBN'] = read_bn(r)
    read_act(r, v)
    m['trunk'] = t
    p = {'name': r.tok()}
    p['p1Conv'] = read_conv(r)
    p['g1Conv'] = read_conv(r)
    p['g1BN'] = read_bn(r)
    read_act(r, v)
    p['gpMul'] = read_matmul(r)
    p['p1BN'] = read_bn(r)
    read_act(r, v)
    p['p2Conv'] = read_conv(r)
    p['passMul'] = read_matmul(r)
    m['policy'] = p
    h = {'name': r.tok()}
    h['v1Conv'] = read_conv(r)
    h['v1BN'] = read_bn(r)
    read_act(r, v)
    h['v2Mul'] = read_matmul(r)
    h['v2Bias'] = read_matbias(r)
    read_act(r, v)
    h['v3Mul'] = read_matmul(r)
    h['v3Bias'] = read_matbias(r)
    h['sv3Mul'] = read_matmul(r)
    h['sv3Bias'] = read_matbias(r)
    h['ownConv'] = read_conv(r)
    m['value'] = h
    rest = r.d[r.p:].strip()
    assert not rest, f'文件末尾还有 {len(rest)} 字节没有读'
    return m


class G:
    def __init__(self):
        self.nodes, self.inits, self.n = [], [], 0

    def const(self, arr, name=None):
        self.n += 1
        name = name or f'c{self.n}'
        self.inits.append(numpy_helper.from_array(np.asarray(arr), name))
        return name

    def op(self, t, ins, **attrs):
        self.n += 1
        out = f'{t.lower()}{self.n}'
        self.nodes.append(helper.make_node(t, ins, [out], **attrs))
        return out

    def conv(self, x, w, b=None):
        k = w.shape[2]
        ins = [x, self.const(w.astype(np.float32))]
        if b is not None:
            ins.append(self.const(b.astype(np.float32)))
        return self.op('Conv', ins, pads=[k // 2] * 4, kernel_shape=[k, k])

    def affine(self, x, s, b):
        """逐通道 x*s+b（x 为 NCHW）"""
        c = len(s)
        x = self.op('Mul', [x, self.const(s.reshape(1, c, 1, 1))])
        return self.op('Add', [x, self.const(b.reshape(1, c, 1, 1))])

    def relu(self, x):
        return self.op('Relu', [x])

    def matmul(self, x, w, b=None):
        y = self.op('MatMul', [x, self.const(w.astype(np.float32))])
        if b is not None:
            y = self.op('Add', [y, self.const(b.astype(np.float32))])
        return y


def fold(conv, bn):
    """conv 后面紧跟的 BN 并进卷积：返回 (权重, 偏置)"""
    return conv['w'] * bn['s'][:, None, None, None], bn['b']


def build(m, fp16=False):
    g = G()
    t = m['trunk']
    # 棋盘边长相关系数：(sqrt(H*W) - 14) * 0.1
    shp = g.op('Shape', ['spatial'])
    hw = g.op('Slice', [shp, g.const(np.array([2], np.int64)), g.const(np.array([4], np.int64))])
    area = g.op('ReduceProd', [hw], keepdims=0)
    areaf = g.op('Cast', [area], to=TensorProto.FLOAT)
    sq = g.op('Sqrt', [areaf])
    k1 = g.op('Mul', [g.op('Sub', [sq, g.const(np.float32(14.0))]), g.const(np.float32(0.1))])  # 标量
    k2 = g.op('Sub', [g.op('Mul', [k1, k1]), g.const(np.float32(0.1))])  # ((s-14)^2*0.01 - 0.1)

    def gpool(x):
        mean = g.op('ReduceMean', [x], axes=[2, 3], keepdims=0)
        mx = g.op('ReduceMax', [x], axes=[2, 3], keepdims=0)
        return g.op('Concat', [mean, g.op('Mul', [mean, k1]), mx], axis=1)

    def vpool(x):
        mean = g.op('ReduceMean', [x], axes=[2, 3], keepdims=0)
        return g.op('Concat', [mean, g.op('Mul', [mean, k1]), g.op('Mul', [mean, k2])], axis=1)

    def unsq(x):
        return g.op('Unsqueeze', [x, g.const(np.array([2, 3], np.int64))])

    x = g.conv('spatial', t['initConv']['w'])
    x = g.op('Add', [x, unsq(g.matmul('global', t['initMatMul']['w']))])
    for b in t['blocks']:
        a = g.relu(g.affine(x, b['preBN']['s'], b['preBN']['b']))
        s = b['midBN']['s']
        if b['kind'] == 'gpool_block':
            reg = g.conv(a, b['regConv']['w'] * s[:, None, None, None])
            gw, gb = fold(b['gpConv'], b['gpBN'])
            gp = g.relu(g.conv(a, gw, gb))
            bias = g.matmul(gpool(gp), b['gpMul']['w'] * s[None, :], b['midBN']['b'])
            y = g.relu(g.op('Add', [reg, unsq(bias)]))
        else:
            w, bb = fold(b['regConv'], b['midBN'])
            y = g.relu(g.conv(a, w, bb))
        y = g.conv(y, b['finalConv']['w'])
        x = g.op('Add', [x, y])
    trunk = g.relu(g.affine(x, t['tipBN']['s'], t['tipBN']['b']))

    p = m['policy']
    s = p['p1BN']['s']
    p1 = g.conv(trunk, p['p1Conv']['w'] * s[:, None, None, None])
    gw, gb = fold(p['g1Conv'], p['g1BN'])
    g1 = g.relu(g.conv(trunk, gw, gb))
    g1p = gpool(g1)
    pb = g.matmul(g1p, p['gpMul']['w'] * s[None, :], p['p1BN']['b'])
    p1 = g.relu(g.op('Add', [p1, unsq(pb)]))
    p2 = g.conv(p1, p['p2Conv']['w'])  # [N,1,H,W]
    p2f = g.op('Flatten', [p2], axis=1)
    ps = g.matmul(g1p, p['passMul']['w'])  # [N,1]
    g.nodes.append(helper.make_node('Concat', [p2f, ps], ['policy'], axis=1))

    h = m['value']
    vw, vb = fold(h['v1Conv'], h['v1BN'])
    v1 = g.relu(g.conv(trunk, vw, vb))
    v2 = g.relu(g.matmul(vpool(v1), h['v2Mul']['w'], h['v2Bias']['b']))
    v3 = g.matmul(v2, h['v3Mul']['w'], h['v3Bias']['b'])
    sv3 = g.matmul(v2, h['sv3Mul']['w'], h['sv3Bias']['b'])
    g.nodes.append(helper.make_node('Identity', [v3], ['value']))
    g.nodes.append(helper.make_node('Identity', [sv3], ['score']))
    own = g.conv(v1, h['ownConv']['w'])
    g.nodes.append(helper.make_node('Flatten', [own], ['ownership'], axis=1))

    nsv = h['sv3Mul']['w'].shape[1]
    graph = helper.make_graph(
        g.nodes, m['name'],
        [helper.make_tensor_value_info('spatial', TensorProto.FLOAT, ['N', m['nin'], 'H', 'W']),
         helper.make_tensor_value_info('global', TensorProto.FLOAT, ['N', m['nglob']])],
        [helper.make_tensor_value_info('policy', TensorProto.FLOAT, ['N', 'P']),
         helper.make_tensor_value_info('value', TensorProto.FLOAT, ['N', 3]),
         helper.make_tensor_value_info('score', TensorProto.FLOAT, ['N', nsv]),
         helper.make_tensor_value_info('ownership', TensorProto.FLOAT, ['N', 'HW'])],
        g.inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='weiqi-katago-convert')
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    m = parse(src)
    print(m['name'], 'version', m['version'], 'blocks', m['trunk']['nblocks'], 'channels', m['trunk']['c'])
    model = build(m)
    onnx.save(model, dst)
    print('saved', dst)
