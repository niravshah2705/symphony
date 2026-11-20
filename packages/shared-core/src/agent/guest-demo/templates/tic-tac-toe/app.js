'use strict';

/**
 * The tic-tac-toe starter. `window.GUEST_OPPONENT` is written by the bundle's
 * own index.html from the catalogue's allowlisted variant, so the mode is one of
 * two literals — there is no path from anything a visitor typed to this script.
 */
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const boardEl = document.getElementById('board');
const turnEl = document.getElementById('turn');
const resetEl = document.getElementById('reset');
const againstComputer = window.GUEST_OPPONENT === 'ai';

let cells = [];
let grid = [];

function winnerOf(rows) {
  for (const line of LINES) {
    const [a, b, c] = line.map((i) => rows[i]);
    if (a && a === b && b === c) return { mark: a, line };
  }
  return rows.every(Boolean) ? { mark: 'draw' } : null;
}

function paint(result) {
  cells.forEach((button, index) => {
    button.textContent = grid[index];
    button.disabled = Boolean(grid[index]) || Boolean(result);
  });
  turnEl.textContent = result
    ? (result.mark === 'draw' ? 'Draw.' : `${result.mark} wins.`)
    : `${grid.filter(Boolean).length % 2 === 0 ? 'X' : 'O'} to move`;
}

function play(index, mark) {
  if (grid[index]) return null;
  grid[index] = mark;
  const result = winnerOf(grid);
  paint(result);
  return result;
}

function computerMove() {
  // Win if it can, block if it must, otherwise take the centre or a corner.
  for (const mark of ['O', 'X']) {
    for (let index = 0; index < 9; index += 1) {
      if (grid[index]) continue;
      const trial = grid.slice();
      trial[index] = mark;
      const outcome = winnerOf(trial);
      if (outcome && outcome.mark === mark) return play(index, 'O');
    }
  }
  const open = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter((index) => !grid[index]);
  return open.length ? play(open[0], 'O') : null;
}

function takeTurn(index) {
  const result = play(index, 'X');
  if (result || !againstComputer) return;
  if (!winnerOf(grid)) computerMove();
}

function build() {
  boardEl.textContent = '';
  cells = [];
  grid = Array.from({ length: 9 }, () => '');
  for (let index = 0; index < 9; index += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.setAttribute('aria-label', `Cell ${index + 1}`);
    button.style.minHeight = '4rem';
    button.style.fontSize = '1.6rem';
    button.addEventListener('click', () => takeTurn(index));
    boardEl.append(button);
    cells.push(button);
  }
  paint(null);
}

resetEl.addEventListener('click', () => build());
build();
