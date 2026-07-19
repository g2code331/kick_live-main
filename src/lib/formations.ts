export const FORMATIONS: Record<string, { pos: string; x: number; y: number }[]> = {
  '4-4-2': [
    { pos: 'GK', x: 50, y: 90 },
    { pos: 'RB', x: 15, y: 70 }, { pos: 'CB', x: 37, y: 70 }, { pos: 'CB', x: 63, y: 70 }, { pos: 'LB', x: 85, y: 70 },
    { pos: 'RM', x: 15, y: 47 }, { pos: 'CM', x: 37, y: 47 }, { pos: 'CM', x: 63, y: 47 }, { pos: 'LM', x: 85, y: 47 },
    { pos: 'ST', x: 37, y: 20 }, { pos: 'ST', x: 63, y: 20 },
  ],
  '4-3-3': [
    { pos: 'GK', x: 50, y: 90 },
    { pos: 'RB', x: 15, y: 70 }, { pos: 'CB', x: 37, y: 70 }, { pos: 'CB', x: 63, y: 70 }, { pos: 'LB', x: 85, y: 70 },
    { pos: 'CM', x: 25, y: 48 }, { pos: 'CM', x: 50, y: 48 }, { pos: 'CM', x: 75, y: 48 },
    { pos: 'RW', x: 18, y: 20 }, { pos: 'ST', x: 50, y: 18 }, { pos: 'LW', x: 82, y: 20 },
  ],
  '4-5-1': [
    { pos: 'GK', x: 50, y: 90 },
    { pos: 'RB', x: 15, y: 70 }, { pos: 'CB', x: 37, y: 70 }, { pos: 'CB', x: 63, y: 70 }, { pos: 'LB', x: 85, y: 70 },
    { pos: 'RM', x: 12, y: 48 }, { pos: 'CM', x: 31, y: 48 }, { pos: 'CM', x: 50, y: 48 }, { pos: 'CM', x: 69, y: 48 }, { pos: 'LM', x: 88, y: 48 },
    { pos: 'ST', x: 50, y: 18 },
  ],
  '3-5-2': [
    { pos: 'GK', x: 50, y: 90 },
    { pos: 'CB', x: 25, y: 70 }, { pos: 'CB', x: 50, y: 70 }, { pos: 'CB', x: 75, y: 70 },
    { pos: 'RWB', x: 10, y: 50 }, { pos: 'CM', x: 30, y: 50 }, { pos: 'CM', x: 50, y: 50 }, { pos: 'CM', x: 70, y: 50 }, { pos: 'LWB', x: 90, y: 50 },
    { pos: 'ST', x: 35, y: 20 }, { pos: 'ST', x: 65, y: 20 },
  ],
  '4-2-3-1': [
    { pos: 'GK', x: 50, y: 90 },
    { pos: 'RB', x: 15, y: 72 }, { pos: 'CB', x: 37, y: 72 }, { pos: 'CB', x: 63, y: 72 }, { pos: 'LB', x: 85, y: 72 },
    { pos: 'DM', x: 35, y: 55 }, { pos: 'DM', x: 65, y: 55 },
    { pos: 'RAM', x: 18, y: 35 }, { pos: 'CAM', x: 50, y: 35 }, { pos: 'LAM', x: 82, y: 35 },
    { pos: 'ST', x: 50, y: 16 },
  ],
};
