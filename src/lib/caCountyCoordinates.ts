export interface CountyCoordinate {
  lat: number;
  lng: number;
}

export const CALIFORNIA_COUNTY_COORDINATES: Record<string, CountyCoordinate> = {
  Alameda: { lat: 37.6489, lng: -121.912 },
  Amador: { lat: 38.4454, lng: -120.6552 },
  Butte: { lat: 39.6669, lng: -121.601 },
  Calaveras: { lat: 38.205, lng: -120.5548 },
  Colusa: { lat: 39.1839, lng: -122.233 },
  "Contra Costa": { lat: 37.917, lng: -121.999 },
  "Del Norte": { lat: 41.7459, lng: -123.8968 },
  "El Dorado": { lat: 38.755, lng: -120.5931 },
  Fresno: { lat: 36.8336, lng: -119.7796 },
  Glenn: { lat: 39.5922, lng: -122.3886 },
  Humboldt: { lat: 40.7451, lng: -123.8695 },
  Imperial: { lat: 33.0142, lng: -115.4734 },
  Inyo: { lat: 36.5115, lng: -117.4115 },
  Kern: { lat: 35.3469, lng: -118.7383 },
  Kings: { lat: 36.0652, lng: -119.8151 },
  Lake: { lat: 39.1004, lng: -122.9053 },
  Lassen: { lat: 40.6741, lng: -120.5646 },
  "Los Angeles": { lat: 34.0522, lng: -118.2437 },
  Madera: { lat: 37.2299, lng: -119.7871 },
  Marin: { lat: 38.0834, lng: -122.7633 },
  Mariposa: { lat: 37.4849, lng: -119.9667 },
  Mendocino: { lat: 39.3076, lng: -123.7993 },
  Merced: { lat: 37.2010, lng: -120.7133 },
  Modoc: { lat: 41.5937, lng: -120.775 },
  Mono: { lat: 37.9201, lng: -118.8685 },
  Monterey: { lat: 36.2232, lng: -121.1787 },
  Napa: { lat: 38.5025, lng: -122.2654 },
  Nevada: { lat: 39.2902, lng: -121.0214 },
  Orange: { lat: 33.7175, lng: -117.8311 },
  Placer: { lat: 38.751, lng: -120.7795 },
  Plumas: { lat: 39.9934, lng: -120.8235 },
  Riverside: { lat: 33.9806, lng: -117.3755 },
  Sacramento: { lat: 38.582, lng: -121.4944 },
  "San Benito": { lat: 36.6072, lng: -121.0794 },
  "San Bernardino": { lat: 34.1083, lng: -117.2898 },
  "San Diego": { lat: 32.7157, lng: -117.1611 },
  "San Francisco": { lat: 37.7749, lng: -122.4194 },
  "San Joaquin": { lat: 37.9362, lng: -121.271 },
  "San Luis Obispo": { lat: 35.2828, lng: -120.6596 },
  "San Mateo": { lat: 37.4338, lng: -122.4303 },
  "Santa Barbara": { lat: 34.4208, lng: -119.6982 },
  "Santa Clara": { lat: 37.3541, lng: -121.9552 },
  "Santa Cruz": { lat: 37.0165, lng: -122.0298 },
  Shasta: { lat: 40.5853, lng: -122.3917 },
  Siskiyou: { lat: 41.585, lng: -122.5334 },
  Solano: { lat: 38.2926, lng: -121.8998 },
  Sonoma: { lat: 38.2919, lng: -122.4587 },
  Stanislaus: { lat: 37.5639, lng: -120.9954 },
  Sutter: { lat: 39.0361, lng: -121.7035 },
  Tehama: { lat: 40.133, lng: -122.2359 },
  Trinity: { lat: 40.6615, lng: -123.111 },
  Tulare: { lat: 36.2036, lng: -118.7858 },
  Tuolumne: { lat: 38.0168, lng: -120.2494 },
  Ventura: { lat: 34.3705, lng: -119.1399 },
  Yolo: { lat: 38.7646, lng: -121.9018 },
  Yuba: { lat: 39.2616, lng: -121.3458 }
};

export const CALIFORNIA_CENTER: CountyCoordinate = { lat: 36.7783, lng: -119.4179 };

export function getCountyCoordinate(county: string): CountyCoordinate | null {
  return CALIFORNIA_COUNTY_COORDINATES[county] ?? null;
}
