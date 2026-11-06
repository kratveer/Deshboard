"""Independent verification of Daylight's local code drawing (ui/codes.js) and reading (ui/code-reader.js).
Encoders: Daylight, libqrencode (QR), zxing-cpp (Code 128). Decoders: Daylight, ZBar, zxing-cpp.
Images are synthetic: clean, rotated, perspective, blur, noise, uneven light, JPEG, low resolution, inverted.
Run: python3 tests/crosscheck/crosscheck.py   (needs node, numpy, opencv, libqrencode, libzbar, libZXing, g++)"""
import json, os, subprocess, sys, tempfile, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import native
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..', '..')
rng = np.random.default_rng(7)

def node_json(js):
    return json.loads(subprocess.check_output(['node', '-e', js], cwd=ROOT))
TEXTS = ['A', 'Hello', 'ticket 123', '0123456789', 'HTTPS://EXAMPLE.COM/T/42', 'M1DOE/JOHN EABC123 PRGLHRBA 0850 123Y012A0001 100',
         'jízdenka Praha → Brno 2. tř.', 'https://example.com/ticket?id=12345&seat=12A', 'MEMBER-778812', '9' * 60, 'x' * 220, 'ÄÖÜ ß € 漢字', 'Q' * 600]
def daylight_qr(text, level):
    m = node_json("const C=require('./ui/codes.js');console.log(JSON.stringify(C.qrMatrix(%s,%s).map(r=>r.map(c=>c?1:0))))" % (json.dumps(text), json.dumps(level)))
    return np.array(m, dtype=np.uint8)
def daylight_128(text):
    return node_json("const C=require('./ui/codes.js');const v=C.code128Values(%s);if(!v){console.log('null');process.exit(0)}let s=v[0];for(let i=1;i<v.length;i++)s+=v[i]*i;let o='';v.concat([s%%103,106]).forEach(c=>{let b=1;for(const d of C.C128[c]){o+=(b?'1':'0').repeat(+d);b^=1}});console.log(JSON.stringify(o))" % json.dumps(text))

def raster_qr(m, px):
    img = (1 - np.pad(m, 4)) * 255
    return np.kron(img, np.ones((px, px))).astype(np.uint8)
def raster_1d(bits, px, h=80):
    row = np.array([0 if b == '1' else 255 for b in ('0' * 12 + bits + '0' * 12)], dtype=np.uint8)
    img = np.tile(np.repeat(row, px), (h, 1)); return np.pad(img, ((20, 20), (0, 0)), constant_values=255)

def distort(img, kind):
    h, w = img.shape
    big = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    H, W = big.shape
    if kind == 'clean': return big
    if kind.startswith('rot'):
        a = float(kind[3:]); M = cv2.getRotationMatrix2D((W / 2, H / 2), a, 1.0)
        c, s = abs(M[0, 0]), abs(M[0, 1]); nw, nh = int(H * s + W * c), int(H * c + W * s); M[0, 2] += nw / 2 - W / 2; M[1, 2] += nh / 2 - H / 2
        return cv2.warpAffine(big, M, (nw, nh), borderValue=255, flags=cv2.INTER_LINEAR)
    if kind == 'perspective':
        src = np.float32([[0, 0], [W, 0], [0, H], [W, H]]); d = 0.12
        dst = np.float32([[W * d, H * 0.05], [W * (1 - d * 0.3), 0], [0, H], [W, H * (1 - d)]])
        return cv2.warpPerspective(big, cv2.getPerspectiveTransform(src, dst), (W, H), borderValue=255)
    if kind == 'blur': return cv2.GaussianBlur(big, (0, 0), 1.2)
    if kind == 'noise': return np.clip(big.astype(np.int16) + rng.normal(0, 18, big.shape), 0, 255).astype(np.uint8)
    if kind == 'light':
        g = np.linspace(0.35, 1.0, W)[None, :] * np.linspace(1.0, 0.6, H)[:, None]
        return np.clip(big * g + 20, 0, 255).astype(np.uint8)
    if kind == 'jpeg':
        ok, enc = cv2.imencode('.jpg', cv2.GaussianBlur(big, (0, 0), 0.7), [cv2.IMWRITE_JPEG_QUALITY, 35]); return cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)
    if kind == 'small': return cv2.resize(big, (int(W * 0.55), int(H * 0.55)), interpolation=cv2.INTER_AREA)
    if kind == 'inverted': return 255 - big
    if kind == 'photo':  # rotation + perspective + blur + uneven light + noise + JPEG together
        x = distort(img, 'rot11'); x = cv2.warpPerspective(x, cv2.getPerspectiveTransform(np.float32([[0, 0], [x.shape[1], 0], [0, x.shape[0]], [x.shape[1], x.shape[0]]]), np.float32([[x.shape[1] * .06, 0], [x.shape[1], x.shape[0] * .04], [0, x.shape[0]], [x.shape[1] * .95, x.shape[0]]])), (x.shape[1], x.shape[0]), borderValue=255)
        x = cv2.GaussianBlur(x, (0, 0), 0.9); g = np.linspace(0.5, 1.0, x.shape[1])[None, :]; x = np.clip(x * g + 15 + rng.normal(0, 8, x.shape), 0, 255).astype(np.uint8)
        ok, enc = cv2.imencode('.jpg', x, [cv2.IMWRITE_JPEG_QUALITY, 50]); return cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)
    raise ValueError(kind)

QR_KINDS = ['clean', 'rot15', 'rot33', 'rot90', 'perspective', 'blur', 'noise', 'light', 'jpeg', 'small', 'inverted', 'photo']
C128_KINDS = ['clean', 'rot90', 'rot4', 'blur', 'noise', 'light', 'jpeg', 'small', 'photo']

def main():
    tmp = tempfile.mkdtemp(); cases = []; report = {'encoders': {}, 'readers': {}}
    # --- encoder checks: Daylight output read by two independent decoders
    enc = {'qr_zbar': [0, 0], 'qr_zxing': [0, 0], 'c128_zbar': [0, 0], 'c128_zxing': [0, 0], 'c128_bits_equal_zxing_writer': [0, 0]}
    for t in TEXTS:
        for lv in 'LMQH':
            m = daylight_qr(t, lv); img = distort(raster_qr(m, 4), 'clean')
            z = native.zbar_decode(img); enc['qr_zbar'][1] += 1; enc['qr_zbar'][0] += int(any(v == t for _, v in z))
            enc['qr_zxing'][1] += 1; enc['qr_zxing'][0] += int(native.zxing_decode(img, os.path.join(tmp, 'z.raw')) == t)
            cases.append(dict(src='daylight', level=lv, text=t, m=m))
            q = None
            try: q = native.qrencode(t, lv)
            except Exception: pass
            if q is not None: cases.append(dict(src='libqrencode', level=lv, text=t, m=q))
    C128_TEXTS = ['ABC-123', 'Hello World 2026', 'MEMBER-778812', '12345678', '0042', 'RJ55120', 'gate B12 seat 14C', 'x' * 40, '00112233445566778899']
    c128 = []
    for t in C128_TEXTS:
        bits = daylight_128(t)
        if bits:
            img = distort(raster_1d(bits, 3), 'clean')
            enc['c128_zbar'][1] += 1; enc['c128_zbar'][0] += int(any(v == t for _, v in native.zbar_decode(img)))
            enc['c128_zxing'][1] += 1; enc['c128_zxing'][0] += int(native.zxing_decode(img, os.path.join(tmp, 'z.raw')) == t)
            zbits = native.zxing_code128(t)
            same_policy = t.isdigit() or not any(t[i:i + 4].isdigit() for i in range(len(t) - 3))
            if same_policy: enc['c128_bits_equal_zxing_writer'][1] += 1; enc['c128_bits_equal_zxing_writer'][0] += int(zbits == bits)
            c128.append(dict(src='daylight', text=t, bits=bits))
        c128.append(dict(src='zxing', text=t, bits=native.zxing_code128(t)))
    report['encoders'] = enc
    # --- reader checks on distorted images
    manifest, meta = [], {}
    def add(img, info):
        i = len(manifest); f = os.path.join(tmp, f'{i}.raw'); np.ascontiguousarray(img).tofile(f)
        manifest.append(dict(id=i, file=f, w=img.shape[1], h=img.shape[0])); meta[i] = dict(info, img=f)
    for c in cases:
        if len(c['text']) > 230: continue
        for k in QR_KINDS: add(distort(raster_qr(c['m'], 3 if k == 'small' else 5), k), dict(sym='qr', kind=k, src=c['src'], text=c['text'], level=c['level']))
    for c in c128:
        for k in C128_KINDS: add(distort(raster_1d(c['bits'], 2 if k == 'small' else 3), k), dict(sym='c128', kind=k, src=c['src'], text=c['text']))
    mf = os.path.join(tmp, 'm.json'); json.dump(manifest, open(mf, 'w')); outf = os.path.join(tmp, 'o.json')
    subprocess.check_call(['node', os.path.join(HERE, 'reader-batch.js'), mf, outf])
    res = {r['id']: r for r in json.load(open(outf))}
    rows = {}; wrong = []
    for i, m in meta.items():
        gray = np.fromfile(m['img'], dtype=np.uint8).reshape(manifest[i]['h'], manifest[i]['w'])
        mine = [x.get('rawValue') for x in res[i]['res']]
        ok_me = m['text'] in mine
        if mine and not ok_me: wrong.append((m['sym'], m['kind'], m['text'][:30], mine[:1]))
        ok_zb = any(v == m['text'] for _, v in native.zbar_decode(gray))
        ok_zx = native.zxing_decode(gray, os.path.join(tmp, 'z.raw')) == m['text']
        key = f"{m['sym']}:{m['kind']}"; r = rows.setdefault(key, [0, 0, 0, 0, 0]); r[0] += 1; r[1] += ok_me; r[2] += ok_zb; r[3] += ok_zx; r[4] = max(r[4], res[i]['ms'])
    report['readers'] = {k: dict(images=v[0], daylight=v[1], zbar=v[2], zxing=v[3], slowest_ms=v[4]) for k, v in sorted(rows.items())}
    report['wrong_values_from_daylight_reader'] = wrong
    print(json.dumps(report, indent=1))
    json.dump(report, open(os.path.join(HERE, 'crosscheck-report.json'), 'w'), indent=1)
    bad = [k for k, v in enc.items() if v[0] != v[1]] + (['wrong values'] if wrong else [])
    sys.exit(1 if bad else 0)
if __name__ == '__main__':
    main()
