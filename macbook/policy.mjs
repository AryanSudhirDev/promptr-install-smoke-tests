import os from 'node:os';
export const DEFAULT_SETTINGS={enabled:true,minBatteryPercent:50,pollIntervalMinutes:10,requireAC:true,requireHome:true,promptrDailyTotal:1400,cognispecDailyTotal:1189};
export function validateSettings(s){
 if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==Object.keys(DEFAULT_SETTINGS).length||Object.keys(s).some(k=>!Object.hasOwn(DEFAULT_SETTINGS,k)))throw new Error('Invalid MacBook settings');
 for(const k of ['enabled','requireAC','requireHome'])if(typeof s[k]!=='boolean')throw new Error('Invalid '+k);
 if(!Number.isInteger(s.minBatteryPercent)||s.minBatteryPercent<10||s.minBatteryPercent>95)throw new Error('Invalid battery threshold');
 if(!Number.isInteger(s.pollIntervalMinutes)||s.pollIntervalMinutes<1||s.pollIntervalMinutes>60)throw new Error('Invalid check interval');
 if(!Number.isInteger(s.promptrDailyTotal)||s.promptrDailyTotal<0||s.promptrDailyTotal>1400)throw new Error('Invalid Promptr daily target');
 if(!Number.isInteger(s.cognispecDailyTotal)||s.cognispecDailyTotal<0||s.cognispecDailyTotal>1189)throw new Error('Invalid CogniSpec daily target');
 return {...s};
}
export function parsePower(text){
 const pct=text.match(/(?:InternalBattery[^\n]*|\bid=\d+[^\n]*)\)\s*(\d+)%/);
 const percent=pct?Number(pct[1]):null;
 const known=Number.isInteger(percent)&&percent>=0&&percent<=100&&/Now drawing from '(?:AC|Battery) Power'/.test(text);
 return {known,percent:known?percent:null,onAC:known&&text.includes("Now drawing from 'AC Power'"),charging:/;\s*charging;/.test(text)};
}
const ipNumber=ip=>{const a=ip.split('.').map(Number);if(a.length!==4||a.some(n=>!Number.isInteger(n)||n<0||n>255))throw new Error('Invalid IPv4');return a.reduce((v,n)=>(v*256+n)>>>0,0);};
export function onPhysicalHomeNetwork(cidr,interfaces=os.networkInterfaces()){
 const [network,bitsText]=cidr.split('/'),bits=Number(bitsText);if(!Number.isInteger(bits)||bits<8||bits>30)throw new Error('Invalid home subnet');
 const mask=(0xffffffff<<(32-bits))>>>0,net=ipNumber(network)&mask;
 return Object.entries(interfaces).some(([name,rows])=>/^en\d+$/.test(name)&&rows.some(r=>r.family==='IPv4'&&!r.internal&&(ipNumber(r.address)&mask)===net));
}
export function gate({settings,power,home,freeBytes,configFresh=true}){
 const reasons=[];
 if(!configFresh)reasons.push('settings_unavailable');
 if(!settings.enabled)reasons.push('disabled');
 if(!power.known)reasons.push('power_unknown');
 else {if(power.percent<=settings.minBatteryPercent)reasons.push('battery_threshold');if(settings.requireAC&&!power.onAC)reasons.push('unplugged');}
 if(settings.requireHome&&!home)reasons.push('away_or_home_device_unreachable');
 if(!Number.isFinite(freeBytes)||freeBytes<20*1024**3)reasons.push('low_disk');
 return {eligible:reasons.length===0,reasons};
}
