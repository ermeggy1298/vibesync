// Bundle entry point: exports THREE + GLTFLoader + OrbitControls as globals
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

window.THREE = THREE;
window.THREE.GLTFLoader = GLTFLoader;
window.THREE.OrbitControls = OrbitControls;
