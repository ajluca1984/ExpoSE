/* Copyright (c) Royal Holloway, University of London | Contact Blake Loring (blake@parsed.uk), Duncan Mitchell (Duncan.Mitchell.2015@rhul.ac.uk), or Johannes Kinder (johannes.kinder@rhul.ac.uk) for details or support | LICENSE.md for license details */

"use strict";

// Tests that setting an index outside of the existing length of the array increases the length of the array
var q = symbolic UnderTest initial [0, 1, 1, 4, 4, 1];

if (q.length === 3) {
  q[3] = 12;
  if (q.length === 4) {
    console.log('Success');
  } else {
    throw 'array_set_field_increase_length: This should be unreachable';
  }
}