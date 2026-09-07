const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
exports.run = async () => {
 const out = process.env.RESULTS_DIR;
 const checks = [];
 const record = (name,details) => checks.push({name,status:'passed',details});
 try {
  const target = vscode.extensions.getExtension('aryansudhir.promptr');
  assert(target,'VS Code extension API cannot find installed Promptr');
  assert.equal(target.packageJSON.version,'1.5.6');
  record('Extension discovery',target.id+'@'+target.packageJSON.version);
  await Promise.race([target.activate(), new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Activation timed out after 30 seconds')),30000);t.unref();})]);
  assert(target.isActive,'Promptr did not become active');
  record('Extension activation',true);
  const declared = target.packageJSON.contributes?.commands || [];
  assert(declared.length>0,'No declared commands');
  for (const expected of ['promptr.generatePrompt','promptr.setTemperature','promptr.setCustomContext','promptr.enterAccessToken']) {
   assert(declared.some(c=>c.command===expected),'Missing expected Promptr command declaration: '+expected);
  }
  const actual = await vscode.commands.getCommands(true);
  for(const c of declared) assert(actual.includes(c.command),'Missing command: '+c.command);
  record('Declared commands registered',declared.map(c=>({id:c.command,title:c.title})));
  const bindings = target.packageJSON.contributes?.keybindings || [];
  assert(bindings.length>0,'No keyboard shortcuts contributed');
  for(const b of bindings) assert(actual.includes(b.command),'Keybinding references missing command: '+b.command);
  record('Keybinding targets registered',bindings);
  const config = vscode.workspace.getConfiguration('promptr');
  assert.equal(config.get('temperature'),0.3,'Unexpected clean-install temperature');
  assert.equal(config.get('customContext'),'','Unexpected clean-install custom context');
  await config.update('temperature',0.6,vscode.ConfigurationTarget.Global);
  assert.equal(vscode.workspace.getConfiguration('promptr').get('temperature'),0.6,'Temperature setting did not persist');
  await config.update('temperature',undefined,vscode.ConfigurationTarget.Global);
  assert.equal(vscode.workspace.getConfiguration('promptr').get('temperature'),0.3,'Temperature setting did not reset');
  record('Default settings and round-trip',{temperature:0.3,customContext:'',changedAndReset:true});
  const doc = await vscode.workspace.openTextDocument({language:'plaintext',content:'Promptr clean-install smoke test.\nNo account token or backend request is used.\n'});
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('workbench.action.quickOpen','>Promptr');
  await new Promise(resolve=>setTimeout(resolve,1500));
  cp.execFileSync('scrot',[path.join(out,'promptr-commands.png')],{timeout:15000});
  record('UI screenshot captured','promptr-commands.png');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({run:process.env.TEST_RUN,status:'passed',checks,notTested:['Authenticated prompt refinement','Cursor integration','Windows/macOS compatibility']},null,2));
  console.log('PROMPTR_SMOKE_TEST_PASSED '+JSON.stringify(checks));
 } catch(err) {
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({run:process.env.TEST_RUN,status:'failed',checks,error:String(err.stack||err)},null,2));
  try {cp.execFileSync('scrot',[path.join(out,'failure.png')],{timeout:15000});}catch{}
  throw err;
 }
};
