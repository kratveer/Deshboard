// Test-only shim over the system zxing-cpp 2.2.1 (libZXing.so.3; headers are not installed, so the few types used are declared here
// with the library's 2.2.1 memory layout). Used by tests/crosscheck to decode images and to encode Code 128 independently.
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
namespace ZXing {
enum class ImageFormat : uint32_t { None = 0, Lum = 0x01000000 };
class ImageView { public: const uint8_t* _data; ImageFormat _format; int _width, _height, _pixStride, _rowStride; };
class ReaderOptions { public: alignas(16) unsigned char raw[512]; };
class Result { public: alignas(16) unsigned char raw[8192]; std::string text() const; };
Result ReadBarcode(const ImageView&, const ReaderOptions&);
class BitMatrix { public: int _width, _height; std::vector<uint8_t> _bits; };
namespace OneD { class Code128Writer { public: alignas(16) unsigned char raw[64]; BitMatrix encode(const std::string&, int, int) const; }; }
}
int main(int argc, char** argv) {
  std::string mode = argv[1];
  if (mode == "enc128") { // prints module pattern of Code 128 for argv[2]
    ZXing::OneD::Code128Writer w; memset(w.raw, 0, sizeof w.raw);
    ZXing::BitMatrix m = w.encode(argv[2], 0, 1);
    for (int x = 0; x < m._width; x++) putchar(m._bits[x] ? '1' : '0');
    putchar('\n'); return 0;
  }
  // dec <w> <h> <rawfile>: 8-bit grayscale
  int W = atoi(argv[2]), H = atoi(argv[3]);
  std::ifstream f(argv[4], std::ios::binary); std::vector<uint8_t> buf(W * H); f.read((char*)buf.data(), W * H);
  ZXing::ImageView iv{ buf.data(), ZXing::ImageFormat::Lum, W, H, 1, W };
  ZXing::ReaderOptions o; memset(o.raw, 0, sizeof o.raw);
  // ReaderOptions 2.2.1 defaults: tryHarder/Rotate/Invert/Downscale=1, downscaleFactor=3, minLineCount=2, maxSymbols=255, downscaleThreshold=500, formats=any
  o.raw[0]=0x0F; o.raw[1]=3<<2; o.raw[4]=2; o.raw[5]=0xff; o.raw[6]=0xF4; o.raw[7]=0x01;
  ZXing::Result r = ZXing::ReadBarcode(iv, o);
  std::cout << r.text() << std::endl; return 0;
}
