# The Illinois main quad, from lidar

A 450 by 600 metre crop of the University of Illinois main quad as a 3D gaussian
splat, served as a static site: <https://fengyuan-zhu.com/quad/>

The shape of every building, path and tree comes from a public airborne lidar
survey rather than from photographs of the site. Colour and material come from
rendering that survey, and the splat is trained on those renders. No Google
Street View imagery is used anywhere, as a source or otherwise.

- **Opening page** a single 553 k-gaussian payload (18 MB) with an orbit
  camera: `index.html` + `quad.splat` + `quad.json`, nothing else to load.
- **walk/** the full tiled model: 17.9 M gaussians in 285 tiles of 32 m with
  levels of detail, streamed by distance (163 MB shipped).
- **about.html** the cover page, with sources and method.

**Sources** 2019 county lidar (USGS 3DEP, public domain), 2023 NAIP
orthoimagery (public domain), OpenStreetMap (ODbL) for names and surfaces.

This repository is the built site only. It is generated from a working tree that
is not published here.
