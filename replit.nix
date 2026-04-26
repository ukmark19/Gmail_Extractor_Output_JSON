{ pkgs }: {
  deps = [
    pkgs.unzipNLS
    pkgs.tesseract
    pkgs.poppler_utils
    pkgs.qpdf
  ];
}