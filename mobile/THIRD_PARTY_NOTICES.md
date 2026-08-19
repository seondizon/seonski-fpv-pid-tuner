# Third-party notices

## SmartTune CLI (`bbl_parser.py`)

`src/blackbox/*.ts` is a clean-room TypeScript port of the Blackbox
(BBL/BFL) binary log frame/predictor/encoding decoder from SmartTune CLI's
`smarttune/platform/betaflight/bbl_parser.py`
(https://github.com/raylanlin/smarttune-cli), used and adapted under the
MIT License below. See `docs/research/reference-analysis.md` (section 5)
and `docs/research/licenses.md` for the license review that cleared this
component for direct reuse/adaptation.

Two defects present in the original `bbl_parser.py` (itself flagged by its
own author as not yet cross-validated against a real decoder) were found
and fixed during this port, via diffing against the real `blackbox_decode`
binary on real-hardware Blackbox data: the `tag8_4S16` encoding's 4-bit
nibble-packing order, and `PREDICTOR_AVERAGE_2`'s use of floor division
instead of the firmware's truncating division. See `src/blackbox/streamReader.ts`
and `src/blackbox/predictors.ts` for details.

```
MIT License

Copyright (c) 2026 Raylan LIN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
