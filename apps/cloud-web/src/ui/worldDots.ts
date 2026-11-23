/**
 * The world as dots, for the Overview's region map: one string per row, north to south, from
 * 78°N to 56°S and 168°W eastwards round to 180°, each character a cell 2.64° square on an
 * equirectangular grid. '.' is sea and 'o' land; 'e' is land in the EU region and 'u' land
 * in the US region (`DOT_REGIONS`). It was rasterised once from hand-drawn coastlines and is
 * meant to read as a map at a glance, not to be one: edit a row by hand to move a dot.
 */
export const WORLD_DOTS: readonly string[] = [
  '.....................oooooooooooo......oooooooooooooooooo...........................................oooo............................',
  '.................oooooooooo...............oooooooooooooo.......................................ooooooooooo..........................',
  '...............................ooooo.......ooooooooooooo..................................oooooooooooooooooooooo..ooooooo...........',
  '.ouuuuuuuuooooooooo.............oooooo.....ooooooooooo................eeeeeeo.........oooooooooooooooooooooooooooooooooooooooooooooo',
  'uuuuuuuuuuooooooooooooooooooooooo.oooooo....ooooooo....eee..........eeeeeeeeoooooooooooooooooooooooooooooooooooooooooooooooooooooooo',
  '.uuuuuuuuuoooooooooooooooooooo......ooo......oooo.......e..........eeee.eeeeooooooooooooooooooooooooooooooooooooooooooooooooooooooo.',
  '..uuuuuuuuoooooooooooooooooo......oooo........oo..................eeee..eeeeooooooooooooooooooooooooooooooooooooooooooooooooooo.....',
  '....uu.......ooooooooooooooo.......ooooo......................e...e.ee...eeoooooooooooooooooooooooooooooooooooooooooo......oo.......',
  '..u...........ooooooooooooooooo...ooooooo.....................e....e....eeoooooooooooooooooooooooooooooooooooooooooo.......oo.......',
  '...............oooooooooooooooooo.oooooooo..................e.ee..eeeeeeeooooooooooooooooooooooooooooooooooooooooooo.......o........',
  '................oooooooooooooooooooooooooo......................eeeeeeeeeooooooooooooooooooooooooooooooooooooooooooooo..............',
  '.................uuuuuuuuuuuuuooooooooooo.....................eeeeeeeeeeeoooooooooooooooooooooooooooooooooooooooooooo...............',
  '.................uuuuuuuuuuuuuuuooooouoo.......................eeeee.eeeeee...oooo..oooooooooooooooooooooooooooooooo.o..............',
  '.................uuuuuuuuuuuuuuuouuuu.......................eeeee...e..eee.....ooo.oooooooooooooooooooooooooooooo....o..............',
  '.................uuuuuuuuuuuuuuuuuu.........................eeee......ee..oooooooo..ooooooooooooooooooooooooo.ooo...................',
  '.................uuuuuuuuuuuuuuuuuu.........................eee....o....e.ooooooooo.ooooooooooooooooooooooooo...o...o...............',
  '..................ouuuuuuuuuuuuuuuo..........................ooooooo.........oooooooooooooooooooooooooooooooo.....oo................',
  '...................oouuuuuuuuuuuu...........................oooooooooo.oo....ooooooooooooooooooooooooooooooooo......................',
  '....................oooouuuu....u...........................oooooooooooooooo.ooooo.ooooooooooooooooooooooooooo......................',
  '......................ooooo...............................ooooooooooooooooooooooooo..oooooooooooooooooooooooo.......................',
  '.......................oooo...............................ooooooooooooooooooo.oooooooo...ooooooooooooooooooo.o......................',
  '........................ooo...o..oo......................ooooooooooooooooooooo.ooooooo.....oooooo..ooooooo..........................',
  '.........................ooooo.....ooo....................oooooooooooooooooooo.oooooo......ooooo...ooooo............................',
  '...........................ooo...........................oooooooooooooooooooooo.oooo........ooo....o.oooo....o......................',
  '..............................oo.........................oooooooooooooooooooooooo...........oo.......oooo.....o.....................',
  '...............................o...oooo...................oooooooooooooooooooooo.oo.........oo.........o............................',
  '.................................oooooooo..................oooooooooooooooooooooooo...........o......o........oo....................',
  '..................................oooooooooo................oooo.ooooooooooooooooo.........................oo.......................',
  '..................................oooooooooo.......................oooooooooooooo....................oo...ooo.......................',
  '.................................oooooooooooo......................ooooooooooooo.....................oo..ooo.o......................',
  '.................................oooooooooooooo.....................ooooooooooo.......................oo..oo.o......o...............',
  '.................................ooooooooooooooooo..................ooooooooooo........................o............ooo.............',
  '..................................oooooooooooooooo..................ooooooooooo..........................oo.........oooo............',
  '..................................oooooooooooooooo...................oooooooooo.....................................................',
  '...................................ooooooooooooooo...................oooooooooo...o..............................oo..o..............',
  '...................................oooooooooooooo...................ooooooooooo..oo............................oooo..oo.............',
  '.....................................oooooooooooo...................oooooooooo..oo............................ooooooooo.............',
  '.....................................ooooooooooo.....................oooooooo...oo..........................oooooooooooo............',
  '.....................................oooooooooo......................oooooooo...oo.........................oooooooooooooo...........',
  '.....................................oooooooo.........................oooooo...............................ooooooooooooooo..........',
  '.....................................oooooooo.........................oooooo...............................ooooooooooooooo..........',
  '.....................................ooooooo..........................ooooo................................ooooooooooooooo..........',
  '....................................ooooooo............................oo...................................oo.....oooooo...........',
  '....................................oooooo...........................................................................oooo........o..',
  '....................................oooo..........................................................................................o.',
  '....................................ooo................................................................................o.........o..',
  '....................................ooo........................................................................................oo...',
  '...................................ooo..............................................................................................',
  '...................................ooo..............................................................................................',
  '....................................oo..............................................................................................',
  '....................................................................................................................................',
];

/** Which region a dot's character marks, by the ids `REGIONS` gives them. */
export const DOT_REGIONS: Readonly<Record<string, string>> = { e: 'eu', u: 'us' };
