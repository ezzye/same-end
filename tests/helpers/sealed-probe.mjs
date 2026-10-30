// Encrypt generated test configurations for hand-off between authorised test hosts.
// No real room data belongs in these configurations.
import {generateKeyPairSync,createPublicKey,createPrivateKey,diffieHellman,hkdfSync,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
const purpose='same-end-generated-probe-v1',aad=Buffer.from(purpose);
const key=(secret,salt)=>Buffer.from(hkdfSync('sha256',secret,salt,aad,32));
export function generateProbeKeys(){
 const pair=generateKeyPairSync('x25519');
 return {publicSpkiBase64:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),privateKeyPem:pair.privateKey.export({format:'pem',type:'pkcs8'})};
}
export function sealProbe(payload,recipientPublicSpkiBase64){
 if(!payload||payload.kind!=='generated-same-end-test')throw Error('Generated test payload required');
 const plain=Buffer.from(JSON.stringify(payload));if(plain.length>128*1024)throw Error('Test payload too large');
 const recipient=createPublicKey({key:Buffer.from(recipientPublicSpkiBase64,'base64'),format:'der',type:'spki'});if(recipient.asymmetricKeyType!=='x25519')throw Error('X25519 test recipient required');
 const ephemeral=generateKeyPairSync('x25519'),salt=randomBytes(32),iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',key(diffieHellman({privateKey:ephemeral.privateKey,publicKey:recipient}),salt),iv);cipher.setAAD(aad);
 const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
 return {version:1,purpose,ephemeralPublicSpkiBase64:ephemeral.publicKey.export({format:'der',type:'spki'}).toString('base64'),salt:salt.toString('base64'),iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function openProbe(envelope,privateKeyPem){
 if(!envelope||envelope.version!==1||envelope.purpose!==purpose)throw Error('Unsupported test envelope');
 const part=(name,length,max=length)=>{const value=envelope[name];if(typeof value!=='string'||value.length>180000||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Invalid encrypted test envelope');const b=Buffer.from(value,'base64');if(b.length<length||b.length>max)throw Error('Invalid encrypted test envelope');return b;};
 const ephemeral=createPublicKey({key:part('ephemeralPublicSpkiBase64',44,128),format:'der',type:'spki'}),privateKey=createPrivateKey(privateKeyPem);if(ephemeral.asymmetricKeyType!=='x25519'||privateKey.asymmetricKeyType!=='x25519')throw Error('X25519 test keys required');
 const decipher=createDecipheriv('aes-256-gcm',key(diffieHellman({privateKey,publicKey:ephemeral}),part('salt',32)),part('iv',12));decipher.setAAD(aad);decipher.setAuthTag(part('tag',16));
 const decoded=JSON.parse(Buffer.concat([decipher.update(part('ciphertext',1,128*1024)),decipher.final()]).toString('utf8'));
 if(!decoded||decoded.kind!=='generated-same-end-test')throw Error('Generated test payload required');return decoded;
}
