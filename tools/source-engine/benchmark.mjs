/** Repro: Node 24 benchmark.mjs /absolute/temp-root [--install]
 * Installs are deliberately outside the checkout; no browser/service/product integration.
 * Output is JSON with full lockfiles, install measurements and three independent processes per case.
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(process.argv[2] ?? '/tmp/rainver-source-engine');
if (process.versions.node.split('.')[0] !== '24') throw new Error('Use the same Node 24 for every case');
const versions = { basic: '@crawlee/basic@3.18.2', cheerio: '@crawlee/cheerio@3.18.2' };
const installs = {};
for (const [name, dependency] of Object.entries(versions)) {
  const dir = join(root, name); await mkdir(dir, {recursive:true});
  if (process.argv.includes('--install')) {
    await writeFile(join(dir, 'package.json'), JSON.stringify({dependencies:{[dependency.slice(0,dependency.lastIndexOf('@'))]:'3.18.2'}}));
    await writeFile(join(dir, 'package-lock.json'), await readFile(join(dirname(fileURLToPath(import.meta.url)), 'locks', name+'.json')));
    const installRuns=[];
    for(let i=0;i<3;i++) {
      const t = performance.now();
      const installed = spawnSync('npm', ['ci', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund'], {encoding:'utf8'});
      if (installed.status !== 0) throw new Error(installed.stderr);
      installRuns.push(performance.now()-t);
    }
    installs[name] = {install_runs_ms:installRuns, install_cache:'warm npm cache; npm ci replaces node_modules each run'};
  }
}
async function size(path) {
  let total = 0;
  for (const d of await readdir(path, {withFileTypes:true})) {
    const p = join(path,d.name); total += d.isDirectory() ? await size(p) : (await stat(p)).size;
  }
  return total;
}
const result = {node:process.version, npm:spawnSync('npm',['--version'],{encoding:'utf8'}).stdout.trim(), platform:process.platform, arch:process.arch, repeats:3, fixture:{documents:100, concurrency:4, body_bytes:4096}, cases:{}};
for (const name of ['baseline','basic','cheerio']) {
  const runs = [];
  for (let i=0;i<3;i++) {
    const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs'), name, root], {encoding:'utf8',maxBuffer:4*1024*1024});
    if (run.status!==0) throw new Error(run.stderr + run.stdout);
    runs.push(JSON.parse(run.stdout.trim()));
  }
  let lock = null;
  if (name!=='baseline') lock=JSON.parse(await readFile(join(root,name,'package-lock.json'),'utf8'));
  const packages = lock ? Object.entries(lock.packages).filter(([p])=>p).map(([path,v])=>({path,version:v.version,integrity:v.integrity,license:v.license})) : [];
  const forbidden = packages.filter(p => /node_modules\/(?:playwright|puppeteer|@crawlee\/(?:browser|cli|jsdom|playwright|puppeteer))(?:\/|$)/.test(p.path));
  result.cases[name]={...installs[name], installed_bytes:lock ? await size(join(root,name,'node_modules')) : 0, package_count:packages.length, forbidden, packages, runs};
  if (lock) await writeFile(join(root,name,'verified-lock.json'),JSON.stringify(lock,null,2));
}
console.log(JSON.stringify(result,null,2));
