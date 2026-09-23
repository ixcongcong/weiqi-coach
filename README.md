# 围棋对战教练

离线围棋学习与对战：内置 KataGo 神经网络（g170 b10c128，转成 ONNX，用 onnxruntime-web 在浏览器里运行）+ PUCT 搜索，另有蒙特卡洛（RAVE）引擎用于低难度和后备，不联网、不调用大模型。网页版可“添加到主屏幕”离线使用：<https://ixcongcong.github.io/weiqi-coach/>

- **对战**：9/13/19 路、5 档难度、AI 胜率控制、让子与贴目、吃子棋；逐手讲解、提示、形势判断、回看（可试下，不改变对局）、提问、新手辅助；每一盘都保存在本机，可导出/导入。
- **学习**：《弈》系统课程 54 课（来自作者的“弈”项目，`tools/yi/`）、27 课动画演示课、39 局名局（9/13/19 路），猜棋模式。
- **练习**：36 道吃子与死活题，答错时演示对方的应法。

## 生成数据

```sh
node tools/make_games.js   # 生成 web/games.js 与 web/problems.js，并用引擎验证每一课、每一题、每一局
```

课程与题目定义在 `tools/curriculum.js`，名局棋谱在 `tools/sgf/`。

Android 外壳（`build.sh`、`src/`）已停止维护，手机请直接使用网页版。

## 神经网络引擎

- 网络：KataGo g170 系列（`g170e-b10c128`、`g170-b6c96`，来自 katagoarchive.org），用 `tools/katago_to_onnx.py` 转成 ONNX，放在 `web/models/`。
- 输入特征在 `web/nn.js` 里实现（与 KataGo V7 特征一致：气、打劫、最近 5 手、征子搜索、Benson 活棋区域、贴目奇偶），已用 `katago kata-raw-nn` 逐点核对，输出误差在 1e-6 量级。
- `web/nnworker.js` 在 Web Worker 里跑 onnxruntime-web（`web/ort/`，WebAssembly），做 PUCT 搜索与单次评估；service worker 加跨源隔离头，支持时自动用多线程。
- 转换命令：`python tools/katago_to_onnx.py g170e-b10c128-….bin.gz web/models/b10.onnx`（需要 numpy、onnx）。
