// 测试共用的取空闲端口:让系统挑一个,关掉再用;挑到 fetch 拒绝连接的端口(WHATWG「bad port」表)就重挑。
// 第 7 波欠账⑤:各测试文件各自挑端口、多数不过滤这张表,系统偶尔给出 6000、6665 之类,fetch 直接拒连,全套假红。
// 只管「挑端口」这一处;测试逻辑不动。
import { createServer } from "node:net";

/** fetch 拒绝连接的端口(https://fetch.spec.whatwg.org/#port-blocking)。 */
export const FETCH_BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554,
  556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080]);

/** 一个此刻空闲、且 fetch 能连的端口。host 缺省 127.0.0.1。 */
export async function freePort(host = "127.0.0.1") {
  for (let i = 0; i < 50; i++) {
    const s = createServer();
    await new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, host, resolve); });
    const port = s.address().port;
    await new Promise((resolve) => s.close(resolve));
    if (!FETCH_BAD_PORTS.has(port)) return port;
  }
  throw new Error("50 次都没挑到 fetch 能连的空闲端口");
}
