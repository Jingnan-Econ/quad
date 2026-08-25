# The Illinois main quad, from lidar

A 450 by 600 metre crop of the University of Illinois main quad as a 3D gaussian
splat, served as a static site: <https://fengyuan-zhu.com/quad/>

The shape of every building, path and tree comes from a public airborne lidar
survey rather than from photographs of the site. Colour and material come from
rendering that survey, and the splat is trained on those renders. No Google
Street View imagery is used anywhere, as a source or otherwise.

- **Model** 17.9 M gaussians, cut into 285 tiles of 32 m with six levels of
  detail. This site ships the coarsest four, which is 163 MB.
- **Streaming** tiles are fetched by distance against a gaussian budget, so an
  opening view costs about 20 MB and zooming in costs more.
- **Sources** 2019 county lidar (USGS 3DEP, public domain), 2023 NAIP
  orthoimagery (public domain), OpenStreetMap (ODbL) for names and surfaces.

This repository is the built site only. It is generated from a working tree that
is not published here.
