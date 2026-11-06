"""ctypes bindings to the system's independent barcode libraries (used only by tests):
libqrencode (QR encoder), ZBar (QR + Code 128 decoder), and zxing-cpp through zxing-shim.cpp (decoder + Code 128 encoder)."""
import ctypes, ctypes.util, os, subprocess, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))

class _QRcode(ctypes.Structure):
    _fields_ = [('version', ctypes.c_int), ('width', ctypes.c_int), ('data', ctypes.POINTER(ctypes.c_ubyte))]
_qr = ctypes.CDLL('libqrencode.so.4')
_qr.QRcode_encodeString.restype = ctypes.POINTER(_QRcode)
_qr.QRcode_encodeString.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
_qr.QRcode_encodeString8bit.restype = ctypes.POINTER(_QRcode)
_qr.QRcode_encodeString8bit.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
LEVEL = {'L': 0, 'M': 1, 'Q': 2, 'H': 3}

def qrencode(text, level='M', eight_bit=False):
    """Independent QR encoder. eight_bit=False lets libqrencode choose numeric/alphanumeric/byte segments."""
    b = text.encode('utf-8')
    p = _qr.QRcode_encodeString8bit(b, 0, LEVEL[level]) if eight_bit else _qr.QRcode_encodeString(b, 0, LEVEL[level], 2, 1)
    if not p: raise ValueError('qrencode failed')
    q = p.contents; w = q.width
    m = np.array([[q.data[y * w + x] & 1 for x in range(w)] for y in range(w)], dtype=np.uint8)
    _qr.QRcode_free(p); return m

_zb = ctypes.CDLL('libzbar.so.0')
for n, r, a in [('zbar_image_scanner_create', ctypes.c_void_p, []), ('zbar_image_scanner_set_config', ctypes.c_int, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]),
                ('zbar_image_create', ctypes.c_void_p, []), ('zbar_image_set_format', None, [ctypes.c_void_p, ctypes.c_ulong]), ('zbar_image_set_size', None, [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]),
                ('zbar_image_set_data', None, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]), ('zbar_scan_image', ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p]),
                ('zbar_image_first_symbol', ctypes.c_void_p, [ctypes.c_void_p]), ('zbar_symbol_next', ctypes.c_void_p, [ctypes.c_void_p]), ('zbar_symbol_get_data', ctypes.c_char_p, [ctypes.c_void_p]),
                ('zbar_symbol_get_type', ctypes.c_int, [ctypes.c_void_p]), ('zbar_image_destroy', None, [ctypes.c_void_p]), ('zbar_image_scanner_destroy', None, [ctypes.c_void_p])]:
    f = getattr(_zb, n); f.restype = r; f.argtypes = a
ZBAR_TYPES = {64: 'qr_code', 128: 'code_128'}

def zbar_decode(gray):
    """Independent decoder (ZBar). gray: 2-D uint8 numpy array. Returns list of (format, text)."""
    sc = _zb.zbar_image_scanner_create(); _zb.zbar_image_scanner_set_config(sc, 0, 0, 1)
    img = _zb.zbar_image_create(); _zb.zbar_image_set_format(img, int.from_bytes(b'Y800', 'little'))
    h, w = gray.shape; _zb.zbar_image_set_size(img, w, h)
    buf = np.ascontiguousarray(gray, dtype=np.uint8); _zb.zbar_image_set_data(img, buf.ctypes.data, w * h, None)
    out = []
    if _zb.zbar_scan_image(sc, img) > 0:
        s = _zb.zbar_image_first_symbol(img)
        while s:
            out.append((ZBAR_TYPES.get(_zb.zbar_symbol_get_type(s), str(_zb.zbar_symbol_get_type(s))), _zb.zbar_symbol_get_data(s).decode('utf-8', 'replace'))); s = _zb.zbar_symbol_next(s)
    _zb.zbar_image_destroy(img); _zb.zbar_image_scanner_destroy(sc); return out

_ZX = os.path.join(HERE, 'zxing-shim')
def _zx_build():
    if not os.path.exists(_ZX):
        subprocess.check_call(['g++', '-O1', '-o', _ZX, os.path.join(HERE, 'zxing-shim.cpp'), '/usr/lib/x86_64-linux-gnu/libZXing.so.3'])
def zxing_decode(gray, tmp):
    _zx_build(); h, w = gray.shape; np.ascontiguousarray(gray, dtype=np.uint8).tofile(tmp)
    r = subprocess.run([_ZX, 'dec', str(w), str(h), tmp], capture_output=True, text=True)
    return r.stdout.rstrip('\n') if r.returncode == 0 else None
def zxing_code128(text):
    """Independent Code 128 encoder (zxing-cpp). Returns module string '1101…'."""
    _zx_build(); return subprocess.check_output([_ZX, 'enc128', text], text=True).strip()
