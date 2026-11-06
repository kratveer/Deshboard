"""Independent check of ui/codes.js: QR matrices from every version range and level are decoded by OpenCV
(QRCodeDetector, and WeChatQRCode when available). Needs node and opencv-contrib-python. Run: python3 tests/codes-decode-check.py"""
import json, subprocess, sys, os
import numpy as np, cv2
here = os.path.dirname(os.path.abspath(__file__))
js = r"""
const C=require(process.argv[1]);const out=[];
const texts=['A','ticket 123','M1DOE/JOHN EABC123 PRGLHRBA 0850 123Y012A0001 100','jízdenka Praha → Brno','https://example.com/t?id=12345'];
for(const l of ['L','M','Q','H']){for(const t of texts)out.push([l,t]);for(let n=20;n<=2900;n=Math.ceil(n*1.35)){const t=Array.from({length:n},(_,i)=>String.fromCharCode(65+(i*7)%26)).join('');if(C.qrMatrix(t,l))out.push([l,t])}}
console.log(JSON.stringify(out.map(([l,t])=>{const m=C.qrMatrix(t,l);return {l,t,m:m.map(r=>r.map(c=>c?1:0).join(''))}})));
"""
data = json.loads(subprocess.check_output(['node', '-e', js, os.path.join(here, '..', 'ui', 'codes.js')]))
det = cv2.QRCodeDetector()
try: wc = cv2.wechat_qrcode_WeChatQRCode()
except Exception: wc = None
fails = []
for q in data:
    m = np.array([[0 if c == '1' else 255 for c in row] for row in q['m']], dtype=np.uint8)
    m = np.pad(m, 4, constant_values=255); ok = False
    for s in (4, 6, 8, 10):
        img = cv2.resize(m, (m.shape[1] * s, m.shape[0] * s), interpolation=cv2.INTER_NEAREST)
        if det.detectAndDecode(img)[0] == q['t']: ok = True; break
        if wc is not None:
            r, _ = wc.detectAndDecode(img)
            if r and r[0] == q['t']: ok = True; break
    if not ok: fails.append((q['l'], (len(q['m']) - 17) // 4, q['t'][:30]))
print(f"QR decode check: {len(data) - len(fails)}/{len(data)} decoded by OpenCV" + (" (incl. WeChatQRCode)" if wc else ""))
for f in fails: print('  FAIL', f)
sys.exit(1 if fails else 0)
