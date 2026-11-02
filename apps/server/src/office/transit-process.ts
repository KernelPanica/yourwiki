// One read-only source is exposed as /input; results stream to the host, never into its filesystem.
import {transitOfficeFile} from './transit.ts';
import {OfficeError} from './errors.ts';
const [format,sizeValue,expandedValue,timeoutValue,outputValue]=process.argv.slice(2);
try{
 const {stat}=await import('node:fs/promises');if((await stat('/input')).size!==Number(sizeValue))throw new OfficeError('INVALID_OFFICE_FILE');
 await transitOfficeFile('/input',format!,process.stdout,AbortSignal.timeout(Number(timeoutValue)),{maxExpandedBytes:Number(expandedValue),maxOutputBytes:Number(outputValue)});
}catch(error){process.stderr.write(error instanceof OfficeError?error.code:'OFFICE_VALIDATOR_FAILED');process.exitCode=1;}
