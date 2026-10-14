"""Local real-photo benchmark: reports OCR lines/timing, never uploads documents."""
import argparse,io,json,logging,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import main
from fastapi import UploadFile
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('inputs',nargs='+');args=parser.parse_args()
logging.getLogger().setLevel(logging.WARNING)
started=time.perf_counter();main.get_ocr();main.get_japanese_ocr();main.get_preview_ocr();startup=time.perf_counter()-started
output={'startupSeconds':round(startup,3),'files':[]}
for value in args.inputs:
 path=Path(value);started=time.perf_counter()
 try:
  result=main.run_ocr(UploadFile(filename=path.name,file=io.BytesIO(path.read_bytes())),300)
  item={'name':path.name,'seconds':round(time.perf_counter()-started,3),'lines':[line.model_dump() for line in result.lines]}
 except Exception as error:item={'name':path.name,'seconds':round(time.perf_counter()-started,3),'error':str(getattr(error,'detail',error))}
 output['files'].append(item);Path(args.output).write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps({key:value for key,value in item.items() if key not in ('lines','readings')},ensure_ascii=False),flush=True)
