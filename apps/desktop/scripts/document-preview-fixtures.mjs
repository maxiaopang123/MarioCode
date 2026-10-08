import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { desktop } from "./electron-test-helper.mjs";
const require = createRequire(join(desktop,"package.json"));
const { zipSync, strToU8 } = require("fflate");
const XLSX = require("xlsx");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=","base64");
export function fixturePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"];
  for (const [index,text] of ["PDF first page fixture","PDF second page fixture"].entries()) {
    const stream = `BT /F1 24 Tf 50 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${index===0?4:6} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let source="%PDF-1.4\n", offsets=[0];
  for (const [index,object] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source+=`${index+1} 0 obj\n${object}\nendobj\n`; }
  const xref=Buffer.byteLength(source);
  source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source);
}
export async function documentFixtures(root) {
  await mkdir(root,{recursive:true});
  await writeFile(join(root,"sample.pdf"), fixturePdf());
  const types='<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>';
  const docx={
    "[Content_Types].xml":strToU8(types),
    "_rels/.rels":strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml":strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文 Word 阅读测试</w:t></w:r></w:p><w:p><w:r><w:t>保留段落内容</w:t></w:r></w:p><w:p><w:hyperlink r:id="bad"><w:r><w:t>安全链接测试</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>'),
    "word/styles.xml":strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>'),
    "word/_rels/document.xml.rels":strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.docPreviewUnsafe=true" TargetMode="External"/><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>'),
    "word/media/image.png":png,
  };
  await writeFile(join(root,"sample.docx"),zipSync(docx));
  const rows=Array.from({length:205},(_,index)=>[index===0?"中文工作表":`Row ${index+1}`,index]);
  const book=XLSX.utils.book_new(); const sheet=XLSX.utils.aoa_to_sheet(rows);
  sheet.B2={t:"n",v:42,f:"SUM(20,22)",z:"0.00"};
  sheet.DW1={t:"s",v:"后续列内容"};sheet["!ref"]="A1:DW205";
  XLSX.utils.book_append_sheet(book,sheet,"中文测试");
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([["第二表内容",true]]),"第二页");
  for(const extension of ["xlsx","xls"]) await writeFile(join(root,`sample.${extension}`),XLSX.write(book,{type:"buffer",bookType:extension==="xls"?"biff8":"xlsx"}));
  const slide=text=>`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="image1"/></p:blipFill></p:pic><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>幻灯片表格</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;
  const slides={"[Content_Types].xml":strToU8(types),
    "ppt/presentation.xml":strToU8('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="first"/><p:sldId id="257" r:id="second"/></p:sldIdLst></p:presentation>'),
    "ppt/_rels/presentation.xml.rels":strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Target="slides/slide2.xml"/><Relationship Id="second" Target="slides/slide1.xml"/></Relationships>'),
    "ppt/slides/slide2.xml":strToU8(slide("第一张中文幻灯片")),"ppt/slides/slide1.xml":strToU8(slide("第二张幻灯片")),"ppt/media/image.png":png,
  };
  for(const index of [1,2]) slides[`ppt/slides/_rels/slide${index}.xml.rels`]=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Target="../media/image.png"/></Relationships>');
  await writeFile(join(root,"sample.pptx"),zipSync(slides));
  await writeFile(join(root,"broken.pptx"),Buffer.from("not an office archive"));
}
