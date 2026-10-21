/** Browser-only Excel (.xlsx) and CSV parser for a single student sheet.
 * No external parser/CDN, and no file content leaves the browser until Import is confirmed.
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i=0;i<text.length;i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell=''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i+1] === '\n') i++; row.push(cell); if (row.some(v=>v.trim())) rows.push(row); row=[]; cell=''; }
    else cell += ch;
  }
  if (quoted) throw new Error('Unclosed quotation mark in CSV file.');
  row.push(cell); if (row.some(v=>v.trim())) rows.push(row);
  return rows;
}
function asXml(bytes: Uint8Array) {
  const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(bytes), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The Excel file contains invalid XML.');
  return doc;
}
function children(element: Element, local: string) { return Array.from(element.children).filter(n=>n.localName===local); }
function descendants(doc: Document | Element, local: string) { return Array.from(doc.getElementsByTagName('*')).filter(n=>n.localName===local); }
const decoder = new TextDecoder('utf-8');
async function extractZip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let eocd = -1;
  for (let pos = bytes.length-22; pos >= Math.max(0,bytes.length-65557); pos--) {
    if (view.getUint32(pos,true)===0x06054b50) { eocd=pos; break; }
  }
  if (eocd<0) throw new Error('Invalid XLSX archive.');
  const total = view.getUint16(eocd+10,true), central = view.getUint32(eocd+16,true);
  if (total>1000) throw new Error('This Excel file has too many entries.');
  let at=central; const entries = new Map<string,Uint8Array>();
  for (let i=0;i<total;i++) {
    if (view.getUint32(at,true)!==0x02014b50) throw new Error('Malformed Excel ZIP directory.');
    const method=view.getUint16(at+10,true), size=view.getUint32(at+20,true), outputSize=view.getUint32(at+24,true);
    const nameSize=view.getUint16(at+28,true), extra=view.getUint16(at+30,true), comment=view.getUint16(at+32,true);
    const off=view.getUint32(at+42,true), name=decoder.decode(bytes.subarray(at+46,at+46+nameSize));
    at+=46+nameSize+extra+comment;
    if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
    if (outputSize>10*1024*1024 || size>10*1024*1024 || off+30>bytes.length || view.getUint32(off,true)!==0x04034b50) throw new Error('Invalid or oversized Excel data.');
    const start=off+30+view.getUint16(off+26,true)+view.getUint16(off+28,true), compressed=bytes.slice(start,start+size);
    let content: Uint8Array;
    if (method===0) content=compressed;
    else if (method===8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Use an updated browser for XLSX, or save Excel as CSV.');
      const stream=new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      content=new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error('Unsupported Excel compression. Save as CSV instead.');
    if (content.length!==outputSize) throw new Error('Excel entry size mismatch.');
    entries.set(name,content);
  }
  return entries;
}
function columnIndex(ref:string) { let result=0; for(const ch of ref.match(/^[A-Z]+/i)?.[0].toUpperCase()||'') result=result*26+ch.charCodeAt(0)-64; return result-1; }
export async function readSpreadsheet(file:File):Promise<string[][]> {
  if (file.size>5*1024*1024) throw new Error('Choose an Excel/CSV file smaller than 5 MB.');
  if (/\.csv$/i.test(file.name)) return parseCSV(await file.text());
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose a .xlsx or .csv file.');
  const entries=await extractZip(await file.arrayBuffer());
  const sheet=[...entries.entries()].filter(([k])=>/^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}))[0]?.[1];
  if (!sheet) throw new Error('No Excel worksheet found.');
  const shared=entries.get('xl/sharedStrings.xml');
  const strings=shared?descendants(asXml(shared),'si').map(si=>descendants(si,'t').map(t=>t.textContent||'').join('')):[];
  const sheetDoc=asXml(sheet);
  const out:string[][]=[];
  for (const row of descendants(sheetDoc,'row')) {
    const index=Number(row.getAttribute('r'));
    if (!Number.isSafeInteger(index)||index<1||index>10001) throw new Error('Too many Excel rows.');
    const cells:string[]=[];
    for (const cell of children(row,'c')) {
      const ci=columnIndex(cell.getAttribute('r')||'');
      if (ci<0 || ci>60) continue;
      const type=cell.getAttribute('t'), text=type==='inlineStr'?descendants(cell,'t').map(t=>t.textContent||'').join(''):children(cell,'v')[0]?.textContent||'';
      cells[ci]=type==='s' ? (strings[Number(text)]||'') : text;
    }
    if (cells.some(v=>v?.trim())) out.push(cells);
  }
  return out;
}
