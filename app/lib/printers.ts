export type Bed = [number, number, number];
export type Printer = { id: string; name: string; bed: Bed };

// Approximate build volumes in mm. Check your printer's spec sheet if exact size matters.
export const PRINTERS: Printer[] = [
  { id: "standard", name: "Standard hobby printer: Ender 3, Creality K1 (220 × 220 × 250)", bed: [220, 220, 250] },
  { id: "bambu", name: "Bambu Lab A1, P1, X1 (256 × 256 × 256)", bed: [256, 256, 256] },
  { id: "prusa", name: "Prusa MK4 (250 × 210 × 220)", bed: [250, 210, 220] },
  { id: "small", name: "Small printer: Bambu A1 mini, Prusa MINI (180 × 180 × 180)", bed: [180, 180, 180] },
  { id: "custom", name: "Custom size", bed: [220, 220, 250] },
];

export const DEFAULT_PRINTER = "standard";