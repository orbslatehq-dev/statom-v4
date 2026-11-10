import { SriLankaPresetLocation } from '../types';

export const SRI_LANKA_BOUNDS: [[number, number], [number, number]] = [
  [79.35, 5.75], // Southwest [lng, lat]
  [82.15, 10.05], // Northeast [lng, lat]
];

export const SRI_LANKA_CENTER = {
  lng: 80.7018,
  lat: 7.8731,
  zoom: 7.35,
};

export const SRI_LANKA_LOCATIONS: SriLankaPresetLocation[] = [
  {
    id: 'maharagama',
    name: 'Maharagama',
    region: 'Western',
    lng: 79.9268,
    lat: 6.8482,
    zoom: 19.2,
    tag: 'RESIDENTIAL',
  },
  {
    id: 'colombo07',
    name: 'Colombo 07',
    region: 'Western',
    lng: 79.8648,
    lat: 6.9064,
    zoom: 19.1,
    tag: 'URBAN VILLAS',
  },
  {
    id: 'nugegoda',
    name: 'Nugegoda',
    region: 'Western',
    lng: 79.8902,
    lat: 6.8726,
    zoom: 19.2,
    tag: 'SUBURBAN',
  },
  {
    id: 'kandy',
    name: 'Kandy',
    region: 'Central',
    lng: 80.6428,
    lat: 7.2896,
    zoom: 19.1,
    tag: 'HILL CAPITAL',
  },
  {
    id: 'galle',
    name: 'Galle Fort',
    region: 'Southern',
    lng: 80.2171,
    lat: 6.0268,
    zoom: 19.3,
    tag: 'CLAY ROOFS',
  },
  {
    id: 'negombo',
    name: 'Negombo',
    region: 'Western',
    lng: 79.8412,
    lat: 7.2115,
    zoom: 19.1,
    tag: 'COASTAL',
  },
  {
    id: 'jaffna',
    name: 'Jaffna',
    region: 'Northern',
    lng: 80.0145,
    lat: 9.6684,
    zoom: 19.1,
    tag: 'NORTHERN',
  },
];
