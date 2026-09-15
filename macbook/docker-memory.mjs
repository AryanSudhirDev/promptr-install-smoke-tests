import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOCKER_SETTINGS_FILE=path.join(os.homedir(),'Library/Group Containers/group.com.docker/settings-store.json');
export const DOCKER_MEMORY_MIB=24*1024;
export const DOCKER_SWAP_MIB=8*1024;

export function dockerMemoryMiB(settings){
 if(!settings||typeof settings!=='object'||Array.isArray(settings))return null;
 const value=settings.MemoryMiB??settings.memoryMiB;
 return Number.isInteger(value)&&value>0?value:null;
}

export function withDockerMemory(settings,{memoryMiB=DOCKER_MEMORY_MIB,swapMiB=DOCKER_SWAP_MIB}={}){
 if(!settings||typeof settings!=='object'||Array.isArray(settings))throw new Error('Invalid Docker settings');
 if(!Number.isInteger(memoryMiB)||memoryMiB<4096||memoryMiB>64*1024)throw new Error('Invalid Docker memory');
 if(!Number.isInteger(swapMiB)||swapMiB<0||swapMiB>64*1024)throw new Error('Invalid Docker swap');
 return {...settings,MemoryMiB:memoryMiB,SwapMiB:swapMiB};
}

export function applyDockerMemorySetting(file=DOCKER_SETTINGS_FILE,limits={}){
 const current=JSON.parse(fs.readFileSync(file,'utf8'));
 const next=withDockerMemory(current,limits);
 if(dockerMemoryMiB(current)===next.MemoryMiB&&(current.SwapMiB??current.swapMiB)===next.SwapMiB)return {changed:false,memoryMiB:next.MemoryMiB,swapMiB:next.SwapMiB};
 const tmp=file+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:0o600});
 fs.renameSync(tmp,file);
 return {changed:true,memoryMiB:next.MemoryMiB,swapMiB:next.SwapMiB,previousMemoryMiB:dockerMemoryMiB(current)};
}
