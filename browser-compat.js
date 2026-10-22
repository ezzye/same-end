/* Fill byte-conversion methods used by recent WebTorrent builds on older browsers. */
(()=>{
  const root=typeof globalThis!=='undefined'?globalThis:typeof self!=='undefined'?self:typeof window!=='undefined'?window:typeof global!=='undefined'?global:this;
  if(typeof globalThis==='undefined')Object.defineProperty(root,'globalThis',{configurable:true,writable:true,value:root});
  const define=(object,name,value)=>{if(typeof object[name]!=='function')Object.defineProperty(object,name,{configurable:true,writable:true,value});};
  if(typeof root.queueMicrotask!=='function')Object.defineProperty(root,'queueMicrotask',{configurable:true,writable:true,value:function(callback){
    if(typeof callback!=='function')throw new TypeError('queueMicrotask callback must be a function.');
    Promise.resolve().then(callback).catch(error=>setTimeout(()=>{throw error;},0));
  }});
  if(typeof Blob!=='undefined'){
    define(Blob.prototype,'arrayBuffer',function(){
      const blob=this;return new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error('Unable to read Blob.'));reader.onabort=()=>reject(reader.error||new Error('Blob read was aborted.'));reader.readAsArrayBuffer(blob);
      });
    });
    define(Blob.prototype,'text',function(){
      const blob=this;return new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error('Unable to read Blob.'));reader.onabort=()=>reject(reader.error||new Error('Blob read was aborted.'));reader.readAsText(blob,'utf-8');
      });
    });
  }
  define(String.prototype,'replaceAll',function(search,replacement){
    if(search instanceof RegExp&&!search.global)throw new TypeError('replaceAll requires a global regular expression.');
    if(search instanceof RegExp)return this.replace(search,replacement);
    const escaped=String(search).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return this.replace(new RegExp(escaped,'g'),replacement);
  });
  define(Array.prototype,'flatMap',function(callback,thisArg){
    const output=[];for(let i=0;i<this.length;i++)if(i in this){const value=callback.call(thisArg,this[i],i,this);if(Array.isArray(value))output.push(...value);else output.push(value);}return output;
  });
  define(Object,'fromEntries',function(entries){const result={};for(const pair of entries){if(!pair||typeof pair[Symbol.iterator]!=='function')throw new TypeError('Iterator value is not an entry object.');const values=Array.from(pair);if(values.length<2)throw new TypeError('Iterator value is not an entry object.');Object.defineProperty(result,values[0],{configurable:true,enumerable:true,writable:true,value:values[1]});}return result;});
  if(typeof Element!=='undefined')define(Element.prototype,'replaceChildren',function(){while(this.firstChild)this.removeChild(this.firstChild);for(const child of arguments)this.append(child instanceof Node?child:document.createTextNode(String(child)));});
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
  if(typeof root.structuredClone!=='function')Object.defineProperty(root,'structuredClone',{configurable:true,writable:true,value:function clonePlain(value){
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
