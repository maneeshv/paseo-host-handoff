import {captureSource} from '@server/capture-helper';
import {captureError} from '@server/capture-error';
async function main() {
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>65536)throw Error('Capture request too large');chunks.push(chunk);}
  return captureSource(JSON.parse(Buffer.concat(chunks).toString()));
}
void main().then(result=>process.stdout.write(JSON.stringify({ok:true,result}))).catch(error=>{
  // Neither arbitrary provider errors nor raw timeline content may cross the source boundary.
  process.stdout.write(JSON.stringify({ok:false,error:captureError(error)}));
});
