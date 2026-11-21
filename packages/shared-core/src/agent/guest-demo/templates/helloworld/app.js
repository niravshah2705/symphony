'use strict';

const GREETINGS = [
  'Hello from the guest demo.',
  'Bonjour — same page, different greeting.',
  'Hola. This file was served as a static asset.',
];

let index = 0;
const out = document.getElementById('out');
const button = document.getElementById('greet');

button.addEventListener('click', () => {
  out.textContent = GREETINGS[index % GREETINGS.length];
  index += 1;
});

document.getElementById('clear').addEventListener('click', () => {
  out.textContent = '';
  index = 0;
});
