/* Copyright (c) Royal Holloway, University of London | Contact Blake Loring (blake@parsed.uk), Duncan Mitchell (Duncan.Mitchell.2015@rhul.ac.uk), or Johannes Kinder (johannes.kinder@rhul.ac.uk) for details or support | LICENSE.md for license details */

"use strict";
 
// Test the behaviour of an array of strings
// Expecting three paths
var q = symbolic UnderTest initial ['a', 'b', 'c'];

if (q.length > 0) {
  if (q[0] === 'a') {
    console.log('If');
  } else if (typeof q[0] === 'string') {
    console.log('Another string value');
  } else {
    throw 'Unreachable';
  }
}