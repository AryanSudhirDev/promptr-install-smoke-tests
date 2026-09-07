const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests} = require('@vscode/test-electron');
(async () => {
 const root = __dirname;
 const resultDir = path.join(root, 'results');
 fs.mkdirSync(resultDir, {recursive:true});
 const userDir = path.join(root,'state','user');
 const extensionsDir = path.join(root,'state','extensions');
 assert(!fs.existsSync(userDir) && !fs.existsSync(extensionsDir), 'Test state must not already exist');
 fs.mkdirSync(path.join(userDir,'User'), {recursive:true});
 fs.mkdirSync(extensionsDir,{recursive:true});
 fs.writeFileSync(path.join(userDir,'User','settings.json'),JSON.stringify({'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,'workbench.startupEditor':'none','workbench.enableExperiments':false,'security.workspace.trust.enabled':false}));
 const executable = await downloadAndUnzipVSCode('stable');
 const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
 function command(args) {
   const r = cp.spawnSync(cli,[...cliArgs,'--user-data-dir',userDir,'--extensions-dir',extensionsDir,'--disable-telemetry',...args],{encoding:'utf8',timeout:180000});
   if(r.error) throw r.error;
   assert.equal(r.status,0, 'VS Code CLI failed: '+r.stderr+' '+r.stdout);
   return r.stdout.trim();
 }
 const before = command(['--list-extensions']);
 assert.equal(before,'','Fresh extension directory was not empty');
 const vsix = path.join(root,'input','promptr.vsix');
 const sha256 = crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
 const installOutput = command(['--install-extension',vsix]);
 const installed = command(['--list-extensions','--show-versions']);
 assert(installed.toLowerCase().split(/\r?\n/).includes('aryansudhir.promptr@1.5.6'), 'Published extension not installed: '+installed);
 const vscodeVersion = command(['--version']);
 const install = {run:process.env.TEST_RUN,os:process.platform,arch:process.arch,hostname:process.env.HOSTNAME,sha256,emptyBeforeInstall:true,installed,vscodeVersion,installOutput};
 fs.writeFileSync(path.join(resultDir,'installation.json'),JSON.stringify(install,null,2));
 console.log(JSON.stringify(install,null,2));
 try {
   await runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:path.join(root,'helper'),extensionTestsPath:path.join(root,'suite.cjs'),extensionTestsEnv:{RESULTS_DIR:resultDir,TEST_RUN:process.env.TEST_RUN},launchArgs:['--user-data-dir',userDir,'--extensions-dir',extensionsDir,'--disable-telemetry','--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-gpu']});
 } finally {
   const logs = path.join(userDir,'logs');
   if(fs.existsSync(logs)) fs.cpSync(logs,path.join(resultDir,'vscode-logs'),{recursive:true});
 }
})().catch(err=>{console.error(err);process.exitCode=1;});
