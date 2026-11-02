// Sandboxed verdict-only subprocess. The host exposes one read-only file as /input.
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {validateOfficeFile} from './validation.ts';
import {OfficeError} from './errors.ts';
const [format,sizeValue,expandedValue,timeoutValue]=process.argv.slice(2);
try{
 const size=Number(sizeValue),maximum=Number(expandedValue),timeout=Number(timeoutValue);
 if(!Number.isSafeInteger(size)||size<0||(await stat('/input')).size!==size)throw new OfficeError('INVALID_OFFICE_FILE');
 await validateOfficeFile({read:async(_digest,range)=>createReadStream('/input',range),localFile:async()=>'/input'},{digest:'0'.repeat(64),size},format!,{maxExpandedBytes:maximum,timeoutMs:timeout});
 process.stdout.write('OK\n');
}catch(error){process.stderr.write(error instanceof OfficeError?error.code:'OFFICE_VALIDATOR_FAILED');process.exitCode=1;}
