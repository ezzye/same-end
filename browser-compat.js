/* Fill byte-conversion methods used by recent WebTorrent builds on older browsers. */
(()=>{
  const proto=Uint8Array.prototype;
  if(typeof proto.toBase64!=='function')Object.defineProperty(proto,'toBase64',{configurable:true,writable:true,value:function(){
    let binary='';for(let i=0;i<this.length;i+=0x8000)binary+=String.fromCharCode(...this.subarray(i,Math.min(i+0x8000,this.length)));
    return btoa(binary);
  }});
  if(typeof proto.toHex!=='function')Object.defineProperty(proto,'toHex',{configurable:true,writable:true,value:function(){
    let hex='';for(let i=0;i<this.length;i++)hex+=this[i].toString(16).padStart(2,'0');return hex;
  }});
  if(typeof Uint8Array.fromHex!=='function')Object.defineProperty(Uint8Array,'fromHex',{configurable:true,writable:true,value:function(hex){
    if(typeof hex!=='string'||hex.length%2||/[^\da-f]/i.test(hex))throw new SyntaxError('Invalid hexadecimal string.');
    const bytes=new Uint8Array(hex.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);return bytes;
  }});
  if(typeof Object.hasOwn!=='function')Object.defineProperty(Object,'hasOwn',{configurable:true,writable:true,value:(object,key)=>Object.prototype.hasOwnProperty.call(Object(object),key)});
  if(typeof crypto!=='undefined'&&typeof crypto.randomUUID!=='function'&&typeof crypto.getRandomValues==='function')Object.defineProperty(crypto,'randomUUID',{configurable:true,writable:true,value:function(){
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=bytes.toHex();return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }});
  if(typeof globalThis.structuredClone!=='function')Object.defineProperty(globalThis,'structuredClone',{configurable:true,writable:true,value:function clonePlain(value){
    const seen=new WeakSet();
    function copy(item){
      if(item===undefined||item===null||typeof item==='string'||typeof item==='boolean')return item;
      if(typeof item==='number'){if(!Number.isFinite(item))throw new TypeError('Unsupported value for structuredClone fallback.');return item;}
      if(typeof item!=='object')throw new TypeError('Unsupported value for structuredClone fallback.');
      if(seen.has(item))throw new TypeError('Cyclic data is unsupported by structuredClone fallback.');
      if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw new TypeError('Only plain data is supported by structuredClone fallback.');
      if(Reflect.ownKeys(item).some(key=>typeof key==='symbol'))throw new TypeError('Symbol properties are unsupported by structuredClone fallback.');
      seen.add(item);
      let result;
      if(Array.isArray(item)){const keys=Object.keys(item);if(keys.length!==item.length||keys.some((key,index)=>key!==String(index)))throw new TypeError('Sparse or extended arrays are unsupported by structuredClone fallback.');result=item.map(copy);}
      else{result={};for(const key of Object.getOwnPropertyNames(item)){const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError('Non-data properties are unsupported by structuredClone fallback.');Object.defineProperty(result,key,{value:copy(descriptor.value),enumerable:true,writable:true,configurable:true});}}
      seen.delete(item);return result;
    }
    return copy(value);
  }});
})();
