// test/fixtures/gen.ts — 把 fixture 落一份到 test/fixtures/out/（供人工 xxd/iconv 核对）。
// 生成物不入库（见 .gitignore）；真源永远是 test/fixtures/build.ts。
// 运行：`node test/fixtures/gen.ts`（Node 22.6+/24 直接跑 TS）或 `npm run fixtures`
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, legacyJavaWebTree } from "./build.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of FIXTURES) {
  writeFileSync(path.join(out, f.name), f.make());
}
const tree = legacyJavaWebTree(path.join(out, "legacy-tree"));
for (const f of tree.files) {
  const abs = path.join(tree.dir, ...f.rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, f.buf);
}
console.log(`已生成 ${FIXTURES.length} 个 fixture + ${tree.files.length} 个混合树文件 → ${out}`);
console.log("核对示例：");
console.log(`  xxd ${path.join(out, "gbk.txt")} | head -1`);
console.log(`  iconv -f GBK -t UTF-8 ${path.join(out, "gbk.txt")} | head -3`);
console.log(`  node -e "const b=require('fs').readFileSync('${path.join(out, "gbk.txt").replace(/\\/g, "/")}');try{new TextDecoder('utf-8',{fatal:true}).decode(b);console.log('valid utf8')}catch(e){console.log('NOT valid utf8')}"`);
