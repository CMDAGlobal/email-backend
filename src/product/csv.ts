import { BadRequestException } from '@nestjs/common';
export function readCsv(text:string,requireEmail=true):Record<string,string>[] {
 if(text.length>900000)throw new BadRequestException('CSV must be smaller than 900 KB');
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 text=text.replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else throw new BadRequestException('Invalid CSV quoting');}
  else if(ch===','&&!quoted){row.push(cell);cell='';}
  else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}
  else cell+=ch;
 }
 if(quoted)throw new BadRequestException('Unclosed CSV quote');
 row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
 if(rows.length>2001)throw new BadRequestException('Import at most 2,000 contacts at a time');
 const headers=(rows.shift()??[]).map(h=>h.trim().toLowerCase());
 if(headers.some(h=>!h)||new Set(headers).size!==headers.length||(requireEmail&&!headers.includes('email')))throw new BadRequestException('CSV needs non-empty, unique column names'+(requireEmail?' including email':''));
 return rows.map((r,i)=>{if(r.length!==headers.length)throw new BadRequestException(`Wrong column count at row ${i+2}`);return Object.fromEntries(headers.map((h,j)=>[h,r[j].trim()]));});
}
export function csvCell(value:unknown){let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
