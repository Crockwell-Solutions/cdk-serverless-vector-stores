# Heathrow demo PDF

`uk-aip-heathrow-demo.pdf` is the bundled input for the vector-store demo: **9 pages, 2,270,016 bytes (about 2.3 MB)**. The CLI processes the entire file. The full UK AIP is not needed to run the demo.

The excerpt preserves the source text, tables, charts, and printed AIP page identifiers. Search results and the example questions refer to **physical pages 1-9 in this demo PDF**, using the mapping below.

| Demo PDF page | Original PDF page | Content                                                |
| ------------- | ----------------- | ------------------------------------------------------ |
| 1             | 157               | GEN 2.1: units, calendar, and time reference           |
| 2             | 381               | ENR 1.7: altimeter setting procedures                  |
| 3             | 382               | ENR 1.7: transition altitudes table                    |
| 4             | 383               | ENR 1.7: continuation of altimetry reference material  |
| 5             | 2743              | EGLL AD 2.12: Heathrow runway physical characteristics |
| 6             | 2744              | Heathrow runway characteristics and declared distances |
| 7             | 2745              | Heathrow approach and runway lighting                  |
| 8             | 2781              | Heathrow aerodrome chart                               |
| 9             | 2782              | Heathrow aircraft ground movement/all taxiways chart   |

Source: the user-supplied UK Aeronautical Information Publication, `EG-aip-en-03-09-2026.pdf` (3 September 2026), containing 3,876 pages and 746,384,998 bytes. The full original remains excluded from Git. The excerpt was assembled without rasterizing or downsampling the source pages; the original publication notices and chart markings remain on the pages.

Demo PDF SHA-256: `888abd06f9edafaeec2ef89d30591bb4558bd14b8327e7317b24c5990d8fea23`.

This dated excerpt is for software demonstrations and retrieval evaluation, not flight planning or operational use.
