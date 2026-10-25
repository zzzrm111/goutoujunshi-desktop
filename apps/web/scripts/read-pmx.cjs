const fs = require("fs");
const pmxPath = process.argv[2] || process.env.PMX_PATH;
if (!pmxPath) {
  console.error("用法: node read-pmx.cjs <模型.pmx>");
  process.exit(1);
}
const buf = fs.readFileSync(pmxPath);
const magic = buf.toString("ascii", 0, 4);
const version = buf.readFloatLE(4);
console.log("magic:", JSON.stringify(magic), "version:", version);
let off = 8;
const globalsCount = buf.readUInt8(off); off += 1;
console.log("globals count:", globalsCount);
const enc = buf.readUInt8(off); off += 1;
const encName = enc === 0 ? "UTF-16LE" : "UTF-8";
console.log("encoding:", encName);
const extraVec4 = buf.readUInt8(off); off += 1;
const vertexIndexSize = buf.readUInt8(off); off += 1;
const textureIndexSize = buf.readUInt8(off); off += 1;
const materialIndexSize = buf.readUInt8(off); off += 1;
const boneIndexSize = buf.readUInt8(off); off += 1;
const morphIndexSize = buf.readUInt8(off); off += 1;
const rigidbodyIndexSize = buf.readUInt8(off); off += 1;
console.log("index sizes v/t/m/b/mo/r:", vertexIndexSize, textureIndexSize, materialIndexSize, boneIndexSize, morphIndexSize, rigidbodyIndexSize);
function readStr() {
  const len = buf.readInt32LE(off); off += 4;
  if (len <= 0) return "";
  const s = buf.toString(enc === 0 ? "utf16le" : "utf8", off, off + len);
  off += len;
  return s;
}
const nameJp = readStr();
const nameEn = readStr();
const commentJp = readStr();
const commentEn = readStr();
console.log("=== 名称(本地) ==="); console.log(nameJp);
console.log("=== 名称(通用) ==="); console.log(nameEn);
console.log("=== 说明(本地) ==="); console.log(commentJp);
console.log("=== 说明(通用) ==="); console.log(commentEn);
