#!/usr/bin/env node
// Publish the reviewed web tree while preserving existing Pages-only assets.
import { execFileSync } from 'node:child_process';

const repository = process.env.GITHUB_REPOSITORY || 'ixcongcong/weiqi-coach';
if (repository !== 'ixcongcong/weiqi-coach') throw new Error('Unexpected publication target');
function run(command, args, input) {
  return execFileSync(command, args, { encoding: 'utf8', input, timeout: 45000, maxBuffer: 8 * 1024 * 1024 }).trim();
}
function api(path, method = 'GET', body) {
  const args = ['api', `repos/${repository}/${path}`, '--method', method];
  if (body) args.push('--input', '-');
  return JSON.parse(run('gh', args, body ? JSON.stringify(body) : undefined));
}
const source = run('git', ['rev-parse', 'HEAD']);
const main = api('git/ref/heads/main').object.sha;
if (source !== main) throw new Error('Source is not current remote main; refusing stale deployment');
if (run('git', ['status', '--porcelain'])) throw new Error('Source must be committed and clean');
const site = api('pages');
if (site.source?.branch !== 'gh-pages' || site.source?.path !== '/' || site.build_type !== 'legacy') {
  throw new Error('Existing Pages configuration changed; refusing to change hosting settings');
}
const parent = api('git/ref/heads/gh-pages').object.sha;
const current = api(`git/trees/${parent}?recursive=1`);
if (current.truncated) throw new Error('Incomplete Pages tree');
const remote = new Map(current.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
const tree = run('git', ['ls-tree', '-r', 'HEAD:web']).split('\n').map(line => {
  const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
  if (!match || match[2] !== 'blob' || match[1] !== '100644') throw new Error('Unsupported web tree entry');
  return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
});
if (!tree.some(x => x.path === 'index.html') || !tree.some(x => x.path === 'board-view.js')) throw new Error('Incomplete web source');
const changes = tree.filter(x => remote.get(x.path) !== x.sha);
let published = parent;
if (changes.length) {
  const nextTree = api('git/trees', 'POST', { base_tree: current.sha, tree: changes });
  const commit = api('git/commits', 'POST', { message: `Publish web from ${source}`, tree: nextTree.sha, parents: [parent] });
  // Fast-forward only: a concurrent release must never be overwritten.
  api('git/refs/heads/gh-pages', 'PATCH', { sha: commit.sha, force: false });
  published = commit.sha;
}
api('pages/builds', 'POST');
console.log(JSON.stringify({ source, published, changedFiles: changes.map(x => x.path), url: site.html_url }));
