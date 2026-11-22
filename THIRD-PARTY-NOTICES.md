# Third-party notices

The source repository contains only this project's own code. The release zip, and the `runtime\` folder that `Install.bat` builds, additionally contain the unmodified software below. Each license text ships inside `runtime\`.

| Component | Source | License | License text in the bundle |
|---|---|---|---|
| Python (Windows embeddable package) | https://www.python.org/ | Python Software Foundation License Version 2 | `runtime\LICENSE.txt` |
| Pillow | https://pypi.org/project/pillow/ | MIT-CMU | `runtime\Lib\site-packages\pillow-*.dist-info\licenses\` |
| NumPy | https://pypi.org/project/numpy/ | BSD-3-Clause (with bundled components under their own licenses) | `runtime\Lib\site-packages\numpy-*.dist-info\` |

`tools\install_runtime.ps1` downloads the Python package from python.org (SHA-256 pinned in the script) and the wheels from pypi.org (SHA-256 checked against the PyPI index).
