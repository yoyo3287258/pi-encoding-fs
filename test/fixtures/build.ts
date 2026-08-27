// test/fixtures/build.ts — fixture 的**唯一真源**（§6.1：脚本生成，不提交二进制）。
// 既被 vitest 用例直接 import（在 tmpdir 里铺树），也能用 `node test/fixtures/gen.ts`
// 落一份到 test/fixtures/out/ 供人工 iconv/xxd 核对。
import iconv from "iconv-lite";

const g = (text: string, enc: string): Buffer => iconv.encode(text, enc);

/** 真实感的老 Java Web 源码：中文注释 + 中文标识符/字符串 + 纯 ASCII 行 + CRLF。 */
export const JAVA_SRC = [
  "package com.example.legacy.device;",
  "",
  "/**",
  " * 温控器报警阀值计算（老项目，勿动编码）。",
  " * 作者：张三丰，最后更新：2019-03-14",
  " */",
  "public class ThermostatService {",
  "",
  "    /** 设备名称=温控器A */",
  "    private static final String DEVICE = \"温控器A\";",
  "    private int id = 855;",
  "    private double value = 0;",
  "    public double getValue() {",
  "        return this.value;",
  "    }",
  "",
  "    // 报警阈值=85.5，超过即触发短信",
  "    public String buildMessage() {",
  "        return \"【告警】设备名称=温控器A 当前值=\" + this.value + \"，请及时处理\";",
  "    }",
  "}",
  "",
].join("\r\n");

/** 含 GBK 无法表示的字符（CJK 扩展 B/C）：只有 GB18030 能编（闸门 1 的靶子）。 */
export const RARE_SRC = "注释 䶇 𠀋 生僻字\r\n人名：欧阳䶇\r\n";
/** Big5（繁体）与 EUC-KR（韩文）样本：验证候选链不会串味。 */
export const BIG5_SRC = "標題：測試文件\r\n設備名稱=溫控器A\r\n";
export const EUCKR_SRC = "제목: 테스트 파일\r\n장치 이름=온도조절기A\r\n";
export const LATIN1_SRC = "Grüße, Ordner\xfcbersicht — naïve café\r\n";
/** UTF-8 版同一份内容（T-3 的靶子：GBK 树里混入的真 UTF-8 文件）。 */
export const JAVA_SRC_UTF8 = JAVA_SRC.replace(/\r\n/g, "\n");

export interface Fixture {
  name: string;
  kind: string;
  make: () => Buffer;
  /** 该文件在磁盘上应被判定成的 encoding */
  expectEncoding: string;
}

export const FIXTURES: Fixture[] = [
  { name: "empty.txt", kind: "utf8", make: () => Buffer.alloc(0), expectEncoding: "UTF-8" },
  { name: "utf8bom.txt", kind: "utf8-bom", make: () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), g(JAVA_SRC_UTF8, "UTF-8")]), expectEncoding: "UTF-8" },
  { name: "utf16le.txt", kind: "utf16le", make: () => Buffer.concat([Buffer.from([0xff, 0xfe]), g(JAVA_SRC_UTF8, "UTF-16LE")]), expectEncoding: "UTF-16LE" },
  { name: "utf16be.txt", kind: "utf16be", make: () => Buffer.concat([Buffer.from([0xfe, 0xff]), g(JAVA_SRC_UTF8, "UTF-16BE")]), expectEncoding: "UTF-16BE" },
  { name: "fake-binary.bin", kind: "binary", make: () => Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41, 0x42]), expectEncoding: "BINARY" },
  // UTF-32LE BOM + "标"(U+6807)：Node Buffer 不支持 utf32，手写字节，避免依赖环境
  { name: "utf32le.txt", kind: "binary", make: () => Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x07, 0x68, 0x00, 0x00]), expectEncoding: "BINARY" },
  { name: "ascii.java", kind: "ascii", make: () => Buffer.from(JAVA_SRC.replace(/[^\x00-\x7f]/g, ""), "ascii"), expectEncoding: "UTF-8" },
  { name: "gbk.txt", kind: "cjk", make: () => g(JAVA_SRC, "GBK"), expectEncoding: "GB18030" },
  { name: "gbk-crlf.java", kind: "cjk", make: () => g(JAVA_SRC, "GBK"), expectEncoding: "GB18030" },
  { name: "gb18030-rare.txt", kind: "cjk", make: () => g(RARE_SRC, "GB18030"), expectEncoding: "GB18030" },
  { name: "utf8.java", kind: "utf8", make: () => g(JAVA_SRC_UTF8, "UTF-8"), expectEncoding: "UTF-8" },
  { name: "big5.txt", kind: "cjk", make: () => g(BIG5_SRC, "Big5"), expectEncoding: "GB18030" },
  { name: "euckr.txt", kind: "cjk", make: () => g(EUCKR_SRC, "EUC-KR"), expectEncoding: "GB18030" },
  { name: "latin1.txt", kind: "config/undecidable", make: () => g(LATIN1_SRC, "ISO-8859-1"), expectEncoding: "ISO-8859-1（仅 force 可用）" },
  { name: "truncated-utf8.txt", kind: "unknown", make: () => Buffer.from("中文中间被截断", "utf-8").subarray(0, 7), expectEncoding: "UNKNOWN" },
  { name: "tiny.png", kind: "image", make: () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), expectEncoding: "BINARY" },
];

export const byName = (name: string): Fixture => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

/**
 * 复刻 D:/temp/OAWSSMS 的真实形态（不拷客户代码）：同一目录里 GBK java 与 UTF-8 java 混住、
 * WebContent 下 jsp 以 UTF-8 为主 + 少量 GBK、纯 ASCII 的 .properties、LF 结尾的 GBK java。
 */
export interface TreeSpec {
  dir: string;
  files: { rel: string; buf: Buffer }[];
}

export function legacyJavaWebTree(baseDir: string): TreeSpec {
  const gbkJava = g(JAVA_SRC, "GBK");
  const utf8Java = g(JAVA_SRC_UTF8, "UTF-8");
  const gbkJavaLf = g(JAVA_SRC.replace(/\r\n/g, "\n"), "GBK");
  return {
    dir: baseDir,
    files: [
      { rel: ".encoding-converter.json", buf: Buffer.from(JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK", autoCandidates: ["GB18030", "GBK", "Big5"] }, null, 2), "utf-8") },
      { rel: "src/app/java/com/example/legacy/device/ThermostatService.java", buf: gbkJava },
      { rel: "src/app/java/com/example/legacy/device/IPositionDao.java", buf: utf8Java },
      { rel: "src/app/java/com/example/legacy/device/MaterielDtl.java", buf: gbkJavaLf },
      { rel: "src/wsa/java/com/example/legacy/wsa/FlowStatNode.java", buf: utf8Java },
      { rel: "src/gaj/java/com/example/legacy/gaj/BarChart.java", buf: gbkJava },
      { rel: "WebContent/pages/login.jsp", buf: g(" <%@ page contentType=\"text/html;charset=GBK\" pageEncoding=\"GBK\"%>\r\n<html><body>登录名</body></html>\r\n", "GBK") },
      { rel: "WebContent/pages/msg/wxmessagefeedback.jsp", buf: g(' <%@ page contentType="text/html;charset=UTF-8" pageEncoding="UTF-8"%>\n<html><body>回复微信消息</body></html>\n', "UTF-8") },
      { rel: "WebContent/pages/archiveTransfer/assign/confirmincharge.jsp", buf: Buffer.from(' <%@ page pageEncoding="ISO-8859-1"%>\r\n<!-- pure ascii -->\r\n', "ascii") },
      { rel: "conf/jdbc.properties", buf: Buffer.from("driver_class=oracle.jdbc.OracleDriver\nurl=jdbc:oracle:thin:@127.0.0.1:1521:ORCL\n", "ascii") },
      { rel: "conf/rule/js/rule.js", buf: g("// 规则脚本（UTF-8 作者写的）\nvar ok = true;\n", "UTF-8") },
      { rel: "conf/tplt/DailyMoney.html", buf: g("<html><body>日报金额模板</body></html>\r\n", "UTF-8") },
      { rel: "db/oracle.dsv", buf: Buffer.from([0x00, 0x01, 0x02, 0x80, 0xff, 0x00]), },
    ],
  };
}
