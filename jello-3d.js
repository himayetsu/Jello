var scene, camera, renderer, controls;
var grid = [];
var buffer1 = [], buffer2 = [], temp;
var mouseGridX = 0, mouseGridY = 0;
var isMouseHovering = false;
var waveGenerationEnabled = true;
var raycaster, mouse, plane;
var lastWaveTime = 0;
var waveThrottle = 50;

var size = 10, res = 40;
var damping = 0.93;
var waveSpeed = 1;
var mouseInfluence = 2;
var continuousWaveStrength = 15;

var lodLevels = [
    { distance: 0, step: 1, detail: 1.0, animate: true, maxDistance: 25 },
    { distance: 20, step: 2, detail: 1.0, animate: true, maxDistance: 55 },
    { distance: 50, step: 4, detail: 1.0, animate: true, maxDistance: 75 },
    { distance: 70, step: 8, detail: 1.0, animate: true, maxDistance: Infinity }
];

var lodGrid = [];
var lastLODUpdate = 0;
var lodUpdateInterval = 100;
var geometryCache = {};
var materialCache = {};
var stitchingBlocks = [];
var perimeterBlocks = [];
var currentViewMode = 'default';

var colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0x96ceb4, 0xfeca57, 0xff9ff3];

function getVelocityColor(velocity) {
    var normalizedVelocity = Math.max(-1, Math.min(velocity / 0.5, 1));
    
    if (normalizedVelocity < 0) {
        var ratio = Math.abs(normalizedVelocity);
        return new THREE.Color(0, 1 - ratio, ratio);
    } else {
        var ratio = normalizedVelocity;
        return new THREE.Color(ratio, 1 - ratio, 0);
    }
}

function getAltitudeColor(height) {
    var normalizedHeight = Math.max(0, Math.min((height + 5) / 10, 1));
    
    if (normalizedHeight < 0.5) {
        var ratio = normalizedHeight * 2;
        return new THREE.Color(0, ratio, 1 - ratio);
    } else {
        var ratio = (normalizedHeight - 0.5) * 2;
        return new THREE.Color(ratio, 1 - ratio, 0);
    }
}

function getDebugColor(x, z, step) {
    var checker = ((Math.floor(x / step) + Math.floor(z / step)) % 2);
    var baseColor = checker ? 0x333333 : 0xcccccc;
    
    switch(step) {
        case 1: return baseColor;
        case 2: return baseColor | 0x001100;
        case 3: return baseColor | 0x110000;
        case 4: return baseColor | 0x000011;
        default: return baseColor | 0x111100;
    }
}

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f0f0);
    
    camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(300, 250, 300);
    camera.lookAt(0, 0, 0);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);
    
    var ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);
    
    var directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(150, 150, 100);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.left = -1000;
    directionalLight.shadow.camera.right = 1000;
    directionalLight.shadow.camera.top = 1000;
    directionalLight.shadow.camera.bottom = -1000;
    scene.add(directionalLight);
    
    buffer1 = [];
    buffer2 = [];
    temp = [];
    for (var i = 0; i < res * res; i++) {
        buffer1[i] = 0;
        buffer2[i] = 0;
        temp[i] = 0;
    }
    
    createJelloGrid();
    
    createPerimeter();
    
    var planeGeometry = new THREE.PlaneGeometry(res * size, res * size);
    var planeMaterial = new THREE.MeshBasicMaterial({ visible: false });
    plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    scene.add(plane);
    
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    renderer.domElement.addEventListener('mousemove', onMouseMove, false);
    renderer.domElement.addEventListener('mouseenter', onMouseEnter, false);
    renderer.domElement.addEventListener('mouseleave', onMouseLeave, false);
    renderer.domElement.addEventListener('click', onMouseClick, false);
    window.addEventListener('resize', onWindowResize, false);
    
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.enablePan = true;
    
    controls.mouseButtons = {
        LEFT: null,
        MIDDLE: null,
        RIGHT: THREE.MOUSE.ROTATE
    };
    
    controls.enabled = true;
    animate();
}

function getLODLevel(distance) {
    for (var i = 0; i < lodLevels.length; i++) {
        var level = lodLevels[i];
        if (distance >= level.distance && distance <= level.maxDistance) {
            return level;
        }
    }
    return null;
}

function getAllApplicableLODLevels(distance) {
    var applicableLevels = [];
    
    for (var i = 0; i < lodLevels.length; i++) {
        var level = lodLevels[i];
        if (distance >= level.distance && distance <= level.maxDistance) {
            applicableLevels.push(level);
        }
    }
    
    return applicableLevels;
}

function createStitchingGeometry(fromStep, toStep) {
    var key = fromStep + "_to_" + toStep;
    if (geometryCache[key]) {
        return geometryCache[key];
    }
    
    var avgStep = (fromStep + toStep) / 2;
    var overlapFactor = 1.2;
    var geometry = new THREE.BoxGeometry(avgStep * size * overlapFactor, size, avgStep * size * overlapFactor);
    
    geometryCache[key] = geometry;
    return geometry;
}

function needsStitching(x, z, currentStep) {
    var neighbors = [
        {x: x - currentStep, z: z},
        {x: x + currentStep, z: z},
        {x: x, z: z - currentStep},
        {x: x, z: z + currentStep},
        {x: x - currentStep, z: z - currentStep},
        {x: x + currentStep, z: z - currentStep},
        {x: x - currentStep, z: z + currentStep},
        {x: x + currentStep, z: z + currentStep}
    ];
    
    var differentSteps = [];
    for (var i = 0; i < neighbors.length; i++) {
        var nx = neighbors[i].x;
        var nz = neighbors[i].z;
        
        if (nx >= 0 && nx < res && nz >= 0 && nz < res) {
            var gridIndex = nx + nz * res;
            var neighborBlock = lodGrid[gridIndex];
            
            if (neighborBlock && neighborBlock.step !== currentStep) {
                differentSteps.push({
                    x: nx, z: nz, 
                    step: neighborBlock.step, 
                    direction: i
                });
            }
        }
    }
    
    return differentSteps;
}

function getGeometry(step) {
    var key = step.toString();
    if (!geometryCache[key]) {
        var blockSize = size * step;
        geometryCache[key] = new THREE.BoxGeometry(blockSize, size, blockSize);
    }
    return geometryCache[key];
}

function getMaterial(colorIndex) {
    // Create a new material for each block (no caching for individual colors)
    return new THREE.MeshLambertMaterial({ 
        color: colors[colorIndex],
        transparent: false,
        opacity: 1.0
    });
}

function createJelloGrid() {
    // Initialize empty grid structure
    grid = [];
    lodGrid = new Array(res * res);
    
    // Create initial grid with default LOD
    var mouseX = mouseGridX || Math.floor(res / 2);
    var mouseZ = mouseGridY || Math.floor(res / 2);
    
    // Calculate initial radius based on LOD levels
    var maxLODDistance = 0;
    for (var i = 0; i < lodLevels.length; i++) {
        if (lodLevels[i].maxDistance !== Infinity && lodLevels[i].maxDistance > maxLODDistance) {
            maxLODDistance = lodLevels[i].maxDistance;
        }
    }
    var initialRadius = maxLODDistance || 64; // Create blocks up to max LOD distance
    var startX = Math.max(0, mouseX - initialRadius);
    var endX = Math.min(res, mouseX + initialRadius);
    var startZ = Math.max(0, mouseZ - initialRadius);
    var endZ = Math.min(res, mouseZ + initialRadius);
    
    for (var x = startX; x < endX; x++) {
        for (var z = startZ; z < endZ; z++) {
            var distance = Math.sqrt(Math.pow(x - mouseX, 2) + Math.pow(z - mouseZ, 2));
            var applicableLevels = getAllApplicableLODLevels(distance);
            
            // Create blocks for all applicable LOD levels (enables overlapping)
            for (var l = 0; l < applicableLevels.length; l++) {
                var lodLevel = applicableLevels[l];
                if (x % lodLevel.step === 0 && z % lodLevel.step === 0) {
                    createBlock(x, z, lodLevel);
                }
            }
        }
    }
    
    console.log("Created initial jello grid with", grid.length, "blocks");
}

function createBlock(x, z, lodLevel) {
    var worldX = x - res / 2;
    var worldZ = z - res / 2;
    
    var geometry = getGeometry(lodLevel.step);
    var material = getMaterial((x + z) % colors.length);
        
        var cube = new THREE.Mesh(geometry, material);
    
    // Position the block at its grid cell center
    cube.position.set(worldX * size, 0, worldZ * size);
    
    cube.rotation.set(0, 0, 0); // Ensure clean rotation
        cube.castShadow = true;
        cube.receiveShadow = true;
    
    cube.userData = {
        gridX: x,
        gridZ: z,
        lodLevel: lodLevel,
        step: lodLevel.step,
        animate: lodLevel.animate,
        baseY: 0
    };
        
        scene.add(cube);
        grid.push(cube);
    
    lodGrid[x + z * res] = {
        cube: cube,
        step: lodLevel.step,
        lodLevel: lodLevel
    };
    
    return cube;
}

function createPerimeter() {
    // Clear existing perimeter blocks
    for (var i = 0; i < perimeterBlocks.length; i++) {
        scene.remove(perimeterBlocks[i]);
    }
    perimeterBlocks = [];
    
    // Calculate world bounds
    var halfRes = res / 2;
    var worldMin = -halfRes * size;
    var worldMax = halfRes * size;
    var gridSize = res * size;
    var thickness = size * 3; // Make perimeter thicker
    
    // Create opaque white material
    var material = new THREE.MeshLambertMaterial({ 
        color: 0xffffff, 
        opacity: 1.0, 
        transparent: false 
    });
    
    // Create 4 perimeter walls with taller height and fixed positioning
    var wallHeight = size * 3; // Make walls taller
    var walls = [
        // Top wall (Z+ direction)
        {
            geometry: new THREE.BoxGeometry(gridSize + thickness * 2 - 20, wallHeight, thickness),
            position: {x: 0, y: wallHeight / 2, z: worldMax + thickness / 2 - 10}
        },
        // Bottom wall (Z- direction)
        {
            geometry: new THREE.BoxGeometry(gridSize + thickness * 2 - 20, wallHeight, thickness),
            position: {x: 0, y: wallHeight / 2, z: worldMin - thickness / 2}
        },
        // Left wall (X- direction)
        {
            geometry: new THREE.BoxGeometry(thickness, wallHeight, gridSize + thickness * 2 - 10),
            position: {x: worldMin - thickness / 2, y: wallHeight / 2, z: 0 - 5}
        },
        // Right wall (X+ direction)
        {
            geometry: new THREE.BoxGeometry(thickness, wallHeight, gridSize + thickness * 2 - 20),
            position: {x: worldMax + thickness / 2 - 10, y: wallHeight / 2, z: 0}
        }
    ];
    
    // Create the 4 perimeter walls
    for (var i = 0; i < walls.length; i++) {
        var wall = walls[i];
        var cube = new THREE.Mesh(wall.geometry, material);
        
        cube.position.set(wall.position.x, wall.position.y, wall.position.z);
        cube.castShadow = true;
        cube.receiveShadow = true;
        
        cube.userData = {
            isPerimeter: true,
            baseY: 0
        };
        
        scene.add(cube);
        perimeterBlocks.push(cube);
    }
    
    console.log("Created", perimeterBlocks.length, "perimeter walls");
}

function createStitchingBlock(x, z, fromStep, toStep) {
    // Create a stitching block between two different LOD levels
    var worldX = x - res / 2;
    var worldZ = z - res / 2;
    
    var geometry = createStitchingGeometry(fromStep, toStep);
    var material = getMaterial((x + z) % colors.length); // Each stitching block gets its own material
    
    var cube = new THREE.Mesh(geometry, material);
    
    // Position between the two LOD levels
    cube.position.set(worldX * size, 0, worldZ * size);
    cube.rotation.set(0, 0, 0);
    cube.castShadow = true;
    cube.receiveShadow = true;
    
    cube.userData = {
        gridX: x,
        gridZ: z,
        step: (fromStep + toStep) / 2,
        animate: true,
        baseY: 0,
        isStitching: true,
        fromStep: fromStep,
        toStep: toStep
    };
    
    scene.add(cube);
    stitchingBlocks.push(cube);
    
    return cube;
}

function resetBlockToBaseState(cube) {
    // Reset position to base grid position
    var worldX = cube.userData.gridX - res / 2;
    var worldZ = cube.userData.gridZ - res / 2;
    cube.position.set(worldX * size, cube.userData.baseY, worldZ * size);
    
    // Reset rotation
    cube.rotation.set(0, 0, 0);
    
    // Reset material emissive
    cube.material.emissive.setHex(0x000000);
}

function onMouseMove(event) {
    // Calculate mouse position in normalized device coordinates
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    // Update the picking ray with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);
    
    // Calculate intersections with the plane
    var intersects = raycaster.intersectObject(plane);
    
    if (intersects.length > 0) {
        var point = intersects[0].point;
        // Convert world coordinates to grid coordinates
        mouseGridX = Math.round((point.x / size) + (res / 2));
        mouseGridY = Math.round((point.z / size) + (res / 2));
        
        // Clamp to grid bounds
        mouseGridX = Math.max(0, Math.min(res - 1, mouseGridX));
        mouseGridY = Math.max(0, Math.min(res - 1, mouseGridY));
    } else {
        // Fallback: use screen coordinates if raycasting fails
        var rect = renderer.domElement.getBoundingClientRect();
        var x = event.clientX - rect.left;
        var y = event.clientY - rect.top;
        
        var normalizedX = x / rect.width;
        var normalizedY = y / rect.height;
        
        mouseGridX = Math.floor(normalizedX * res);
        mouseGridY = Math.floor(normalizedY * res);
        
        // Clamp to grid bounds
        mouseGridX = Math.max(0, Math.min(res - 1, mouseGridX));
        mouseGridY = Math.max(0, Math.min(res - 1, mouseGridY));
    }
    
    // Update LOD based on mouse position (throttled)
    var currentTime = Date.now();
    if (currentTime - lastLODUpdate > lodUpdateInterval) {
        updateLOD();
        lastLODUpdate = currentTime;
    }
}

function updateLOD() {
    // Early exit if mouse is out of bounds
    if (mouseGridX < 0 || mouseGridX >= res || mouseGridY < 0 || mouseGridY >= res) {
        return;
    }
    
    // Incremental LOD update - only update blocks that need changes
    // Calculate updateRadius based on the maximum maxDistance from LOD levels
    var maxLODDistance = 0;
    for (var i = 0; i < lodLevels.length; i++) {
        if (lodLevels[i].maxDistance !== Infinity && lodLevels[i].maxDistance > maxLODDistance) {
            maxLODDistance = lodLevels[i].maxDistance;
        }
    }
    var updateRadius = (maxLODDistance || 80) + 10; // Use max LOD distance + buffer
    var blocksToUpdate = [];
    var blocksToCreate = [];
    var blocksToRemove = [];
    
    // Check existing blocks for LOD changes
    for (var i = 0; i < grid.length; i++) {
        var cube = grid[i];
        if (!cube.userData) continue;
        
        var x = cube.userData.gridX;
        var z = cube.userData.gridZ;
        var distance = Math.sqrt(Math.pow(x - mouseGridX, 2) + Math.pow(z - mouseGridY, 2));
        var newLodLevel = getLODLevel(distance);
        
        // If no LOD level applies, mark for removal
        if (!newLodLevel) {
            blocksToRemove.push(i);
            continue;
        }
        
        // If LOD level changed, mark for update
        if (cube.userData.step !== newLodLevel.step) {
            if (x % newLodLevel.step === 0 && z % newLodLevel.step === 0) {
                // Block position is valid for new LOD - update it
                blocksToUpdate.push({cube: cube, newLodLevel: newLodLevel});
            } else {
                // Block position is not valid for new LOD - remove it
                blocksToRemove.push(i);
            }
        }
    }
    
    // Check for new blocks needed in the update area
    var startX = Math.max(0, mouseGridX - updateRadius);
    var endX = Math.min(res, mouseGridX + updateRadius);
    var startZ = Math.max(0, mouseGridY - updateRadius);
    var endZ = Math.min(res, mouseGridY + updateRadius);
    
    // Create blocks for each LOD level with proper overlap
    var createdBlocks = new Set();
    
    for (var x = startX; x < endX; x++) {
        for (var z = startZ; z < endZ; z++) {
            var distance = Math.sqrt(Math.pow(x - mouseGridX, 2) + Math.pow(z - mouseGridY, 2));
            var applicableLevels = getAllApplicableLODLevels(distance);
            
            // Create blocks for all applicable LOD levels (enables overlapping)
            for (var l = 0; l < applicableLevels.length; l++) {
                var lodLevel = applicableLevels[l];
                
                // Calculate proper block position for this LOD level
                var blockX = Math.ceil(x / lodLevel.step) * lodLevel.step;
                var blockZ = Math.ceil(z / lodLevel.step) * lodLevel.step;
                
                var blockKey = blockX + "," + blockZ + "," + lodLevel.step;
                var gridIndex = blockX + blockZ * res;
                
                // Only create if block doesn't exist and we haven't already marked it for creation
                if (!lodGrid[gridIndex] && !createdBlocks.has(blockKey) && 
                    blockX >= 0 && blockX < res && blockZ >= 0 && blockZ < res) {
                    blocksToCreate.push({x: blockX, z: blockZ, lodLevel: lodLevel});
                    createdBlocks.add(blockKey);
                }
            }
        }
    }
    
    // Apply updates efficiently
    updateBlocks(blocksToUpdate, blocksToRemove, blocksToCreate);
    
    // Update stitching after main blocks are updated
    updateStitching();
}

function updateBlocks(blocksToUpdate, blocksToRemove, blocksToCreate) {
    // Update existing blocks (change geometry/material)
    for (var i = 0; i < blocksToUpdate.length; i++) {
        var update = blocksToUpdate[i];
        var cube = update.cube;
        var newLodLevel = update.newLodLevel;
        
        // Update geometry if step changed
        cube.geometry = getGeometry(newLodLevel.step);
        
        // Update user data first
        cube.userData.lodLevel = newLodLevel;
        cube.userData.step = newLodLevel.step;
        cube.userData.animate = newLodLevel.animate;
        cube.userData.baseY = 0; // Reset base Y position
        
        // No offsets needed - blocks positioned at grid centers
        
        // Reset block to clean state when LOD changes
        resetBlockToBaseState(cube);
        
        // Update lodGrid reference
        var gridIndex = cube.userData.gridX + cube.userData.gridZ * res;
        if (lodGrid[gridIndex]) {
            lodGrid[gridIndex].step = newLodLevel.step;
            lodGrid[gridIndex].lodLevel = newLodLevel;
        }
    }
    
    // Remove blocks (in reverse order to maintain indices)
    for (var i = blocksToRemove.length - 1; i >= 0; i--) {
        var index = blocksToRemove[i];
        var cube = grid[index];
        
        // Remove from scene and lodGrid
        scene.remove(cube);
        var gridIndex = cube.userData.gridX + cube.userData.gridZ * res;
        lodGrid[gridIndex] = null;
        
        // Remove from grid array
        grid.splice(index, 1);
    }
    
    // Create new blocks
    for (var i = 0; i < blocksToCreate.length; i++) {
        var create = blocksToCreate[i];
        createBlock(create.x, create.z, create.lodLevel);
    }
    
    if (blocksToUpdate.length > 0 || blocksToRemove.length > 0 || blocksToCreate.length > 0) {
        console.log("LOD update: updated", blocksToUpdate.length, "removed", blocksToRemove.length, "created", blocksToCreate.length);
    }
}

function updateStitching() {
    // Clear existing stitching blocks
    for (var i = 0; i < stitchingBlocks.length; i++) {
        scene.remove(stitchingBlocks[i]);
    }
    stitchingBlocks = [];
    
    // Find LOD boundaries and create stitching blocks
    var stitchingPositions = new Set();
    
    for (var i = 0; i < grid.length; i++) {
        var cube = grid[i];
        if (!cube.userData || cube.userData.isStitching) continue;
        
        var x = cube.userData.gridX;
        var z = cube.userData.gridZ;
        var currentStep = cube.userData.step;
        
        // Check for neighboring blocks with different steps
        var neighbors = needsStitching(x, z, currentStep);
        
        for (var n = 0; n < neighbors.length; n++) {
            var neighbor = neighbors[n];
            var direction = neighbor.direction;
            
            // For higher steps, create multiple stitching blocks to fill gaps
            var stitchCount = Math.max(2, Math.floor(currentStep * 1.5));
            
            for (var s = 0; s < stitchCount; s++) {
                // Calculate positioning offset - smaller for larger steps (more overlap on outer levels)
                var baseOffset = Math.max(1, Math.floor(currentStep / (4 + currentStep * 0.5)));
                var additionalOffset = s * Math.max(1, Math.floor(currentStep / 4));
                
                // For horizontal/vertical edges, also create intermediate positions
                if (direction < 4) { // Only for cardinal directions (not diagonals)
                    // Create stitching blocks at intermediate positions along the edge
                    for (var intermediate = 0; intermediate < currentStep; intermediate++) {
                        var stitchX, stitchZ;
                        
                        switch(direction) {
                            case 0: // Left neighbor - fill vertical edge
                                stitchX = x - baseOffset - additionalOffset;
                                stitchZ = z - Math.floor(currentStep / 2) + intermediate;
                                break;
                            case 1: // Right neighbor - fill vertical edge
                                stitchX = x + baseOffset + additionalOffset;
                                stitchZ = z - Math.floor(currentStep / 2) + intermediate;
                                break;
                            case 2: // Top neighbor - fill horizontal edge
                                stitchX = x - Math.floor(currentStep / 2) + intermediate;
                                stitchZ = z - baseOffset - additionalOffset;
                                break;
                            case 3: // Bottom neighbor - fill horizontal edge
                                stitchX = x - Math.floor(currentStep / 2) + intermediate;
                                stitchZ = z + baseOffset + additionalOffset;
                                break;
                        }
                        
                        // Ensure stitching position is within bounds
                        if (stitchX >= 0 && stitchX < res && stitchZ >= 0 && stitchZ < res) {
                            var stitchKey = stitchX + "," + stitchZ + "," + currentStep + "," + neighbor.step + "," + s + "," + intermediate;
                            
                            if (!stitchingPositions.has(stitchKey)) {
                                createStitchingBlock(stitchX, stitchZ, currentStep, neighbor.step);
                                stitchingPositions.add(stitchKey);
                            }
                        }
                    }
                } else {
                    // Original diagonal stitching
                    var stitchX, stitchZ;
                    
                    switch(direction) {
                        case 4: // Top-left diagonal
                            stitchX = x - baseOffset - additionalOffset;
                            stitchZ = z - baseOffset - additionalOffset;
                            break;
                        case 5: // Top-right diagonal
                            stitchX = x + baseOffset + additionalOffset;
                            stitchZ = z - baseOffset - additionalOffset;
                            break;
                        case 6: // Bottom-left diagonal
                            stitchX = x - baseOffset - additionalOffset;
                            stitchZ = z + baseOffset + additionalOffset;
                            break;
                        case 7: // Bottom-right diagonal
                            stitchX = x + baseOffset + additionalOffset;
                            stitchZ = z + baseOffset + additionalOffset;
                            break;
                    }
                    
                    // Ensure stitching position is within bounds
                    if (stitchX >= 0 && stitchX < res && stitchZ >= 0 && stitchZ < res) {
                        var stitchKey = stitchX + "," + stitchZ + "," + currentStep + "," + neighbor.step + "," + s;
                        
                        if (!stitchingPositions.has(stitchKey)) {
                            createStitchingBlock(stitchX, stitchZ, currentStep, neighbor.step);
                            stitchingPositions.add(stitchKey);
                        }
                    }
                }
            }
        }
    }
}


function onMouseEnter(event) {
    console.log("Mouse entered canvas - starting hover waves!");
    isMouseHovering = true;
}

function onMouseLeave(event) {
    console.log("Mouse left canvas - stopping hover waves!");
    isMouseHovering = false;
}

function onMouseClick(event) {
    // Toggle wave generation on left click
    waveGenerationEnabled = !waveGenerationEnabled;
    console.log("Wave generation", waveGenerationEnabled ? "enabled" : "disabled");
}

function createWaveAtMouse() {
    // Create wave at mouse position - optimized with pre-calculated pattern
    if (mouseGridX >= 0 && mouseGridX < res && mouseGridY >= 0 && mouseGridY < res) {
        var influence = mouseInfluence;
        var resValue = res; // Cache res value
        
        // Pre-calculated wave pattern to avoid sqrt calls in loop
        var waveOffsets = [
            {dx: 0, dy: 0, mult: 1.0},        // Center
            {dx: -1, dy: 0, mult: 0.67}, {dx: 1, dy: 0, mult: 0.67},   // Adjacent
            {dx: 0, dy: -1, mult: 0.67}, {dx: 0, dy: 1, mult: 0.67},   
            {dx: -1, dy: -1, mult: 0.53}, {dx: 1, dy: -1, mult: 0.53}, // Diagonal
            {dx: -1, dy: 1, mult: 0.53}, {dx: 1, dy: 1, mult: 0.53},
            {dx: -2, dy: 0, mult: 0.33}, {dx: 2, dy: 0, mult: 0.33},   // Far
            {dx: 0, dy: -2, mult: 0.33}, {dx: 0, dy: 2, mult: 0.33}
        ];
        
        for (var i = 0; i < waveOffsets.length; i++) {
            var offset = waveOffsets[i];
            var nx = mouseGridX + offset.dx;
            var ny = mouseGridY + offset.dy;
            
            if (nx >= 0 && nx < resValue && ny >= 0 && ny < resValue) {
                buffer1[nx + ny * resValue] += influence * offset.mult;
            }
        }
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function updateWaves() {
    // Create continuous waves while hovering (if wave generation is enabled)
    if (isMouseHovering && waveGenerationEnabled) {
        createWaveAtMouse();
    }
    
    // Optimized wave equation simulation - cache frequently used values
    var resSquared = res * res;
    var resMinusOne = res - 1;
    var waveSpeedSquared = waveSpeed * waveSpeed;
    
    for (var i = 0; i < resSquared; i++) {
        var x = i % res;
        var y = (i / res) | 0; // Bitwise OR for faster Math.floor
        
        var neighbors = 0;
        var count = 0;
        
        // Optimized neighbor checking with early bounds check
        if (x > 0) { neighbors += buffer1[i - 1]; count++; }
        if (x < resMinusOne) { neighbors += buffer1[i + 1]; count++; }
        if (y > 0) { neighbors += buffer1[i - res]; count++; }
        if (y < resMinusOne) { neighbors += buffer1[i + res]; count++; }
        
        if (count > 0) {
            // Optimized wave calculation - reduce divisions and function calls
            var current = buffer1[i];
            var previous = buffer2[i];
            var neighborsAverage = neighbors / count;
            var acceleration = (neighborsAverage - current) * waveSpeedSquared;
            var velocity = (current - previous) * damping;
            
            temp[i] = (current + velocity + acceleration) * damping;
        } else {
            temp[i] = buffer1[i] * damping;
        }
    }
    
    // Optimized buffer swapping
    var swap = buffer2;
    buffer2 = buffer1;
    buffer1 = temp;
    temp = swap;
}

function updateGrid() {
    // Update main grid blocks - cache grid length
    var gridLength = grid.length;
    for (var i = 0; i < gridLength; i++) {
        var cube = grid[i];
        var userData = cube.userData;
        if (!userData) continue;
        
        // Skip calculations for static blocks (performance optimization)
        if (!userData.animate) {
            // Keep static blocks at base position and ensure they're properly reset
            cube.position.y = userData.baseY;
            cube.rotation.set(0, 0, 0); // Ensure rotation stays reset
            cube.material.emissive.setHex(0x000000); // Ensure no glow
            continue;
        }
        
        var gridX = userData.gridX;
        var gridZ = userData.gridZ;
        var step = userData.step;
        var lodLevel = userData.lodLevel;
        
        // Optimized wave height calculation - sample fewer points for lower detail
        var avgWaveHeight = 0;
        if (step <= 2) {
            // High/Medium detail: use single point or simple sampling
            var bufferIndex = gridX + gridZ * res;
            if (bufferIndex < buffer1.length) {
                avgWaveHeight = buffer1[bufferIndex];
            }
        } else {
            // Medium detail: sample center and corners only
            var samplePoints = [
                [gridX, gridZ],                           // Center
                [gridX + step - 1, gridZ],               // Right
                [gridX, gridZ + step - 1],               // Bottom
                [gridX + step - 1, gridZ + step - 1]     // Bottom-right
            ];
            
            var totalWaveHeight = 0;
            var validSamples = 0;
            
            for (var s = 0; s < samplePoints.length; s++) {
                var sampleX = samplePoints[s][0];
                var sampleZ = samplePoints[s][1];
                if (sampleX < res && sampleZ < res) {
                    var bufferIndex = sampleX + sampleZ * res;
                    if (bufferIndex < buffer1.length) {
                        totalWaveHeight += buffer1[bufferIndex];
                        validSamples++;
                    }
                }
            }
            
            avgWaveHeight = validSamples > 0 ? totalWaveHeight / validSamples : 0;
        }
        
        // Update position with reduced calculations
        cube.position.y = avgWaveHeight * 5 * lodLevel.detail;
        
        // Simplified visual updates for better performance
        var intensity = Math.abs(avgWaveHeight) / 75;
        
        // Apply view mode coloring
        if (currentViewMode === 'default') {
            // Default view - all blocks red
            cube.material.color.setHex(colors[0]); // Use the first color (red)
        } else if (currentViewMode === 'velocity') {
            // Velocity view - color based on actual wave velocity
            var bufferIndex = gridX + gridZ * res;
            var velocity = 0;
            
            // Check if this is near the mouse hover position
            var distanceToMouse = Math.sqrt(Math.pow(gridX - mouseGridX, 2) + Math.pow(gridZ - mouseGridY, 2));
            
            if (isMouseHovering && distanceToMouse <= 2) {
                // At hover point, show neutral (green) since we're actively inputting
                velocity = 0;
            } else if (bufferIndex < buffer1.length && bufferIndex < buffer2.length && bufferIndex < temp.length) {
                // True velocity calculation: how much the position changed from previous to current frame
                var currentPos = buffer1[bufferIndex];
                var previousPos = buffer2[bufferIndex];
                velocity = currentPos - previousPos; // This is the actual velocity (rate of change)
            }
            
            var velocityColor = getVelocityColor(velocity);
            cube.material.color.copy(velocityColor);
        } else if (currentViewMode === 'debug') {
            // Debug view - chess pattern based on position and step
            var debugColor = getDebugColor(gridX, gridZ, step);
            cube.material.color.setHex(debugColor);
        } else if (currentViewMode === 'altitude') {
            // Altitude view - color based on height
            var altitudeColor = getAltitudeColor(cube.position.y);
            cube.material.color.copy(altitudeColor);
        }
        
        // Add rotation only for highest detail
        if (step <= 2) {
            cube.rotation.x = avgWaveHeight * 0.2;
            cube.rotation.z = avgWaveHeight * 0.1;
        }
        
        // Mouse highlight only for nearby blocks - optimized distance calculation
        var dx = gridX - mouseGridX;
        var dz = gridZ - mouseGridY;
        var distanceSquared = dx * dx + dz * dz;
        var threshold = step * 1.5;
        
        if (distanceSquared < threshold * threshold) {
            cube.material.emissive.setHex(0x222222); // Subtle glow
        } else {
            cube.material.emissive.setHex(0x000000);
        }
    }
    
    // Update stitching blocks - cache length and userData access
    var stitchingLength = stitchingBlocks.length;
    for (var i = 0; i < stitchingLength; i++) {
        var cube = stitchingBlocks[i];
        var userData = cube.userData;
        if (!userData) continue;
        
        var gridX = userData.gridX;
        var gridZ = userData.gridZ;
        
        // Sample wave height for stitching block (interpolate between neighboring steps)
        var avgWaveHeight = 0;
        var bufferIndex = gridX + gridZ * res;
        if (bufferIndex < buffer1.length) {
            avgWaveHeight = buffer1[bufferIndex];
        }
        
        // Apply wave height with reduced intensity for stitching blocks
        cube.position.y = avgWaveHeight * 3; // Reduced from 5 to 3 for smoother transition
        
        // Apply view mode coloring to stitching blocks - optimized color calculations
        if (currentViewMode === 'default') {
            // Default view - all blocks red
            cube.material.color.setHex(colors[0]); // Use the first color (red)
        } else if (currentViewMode === 'velocity') {
            // Velocity view - color based on wave velocity
            var velocity = avgWaveHeight * 0.5; // Reduced for stitching
            var velocityColor = getVelocityColor(velocity);
            cube.material.color.copy(velocityColor);
        } else if (currentViewMode === 'altitude') {
            // Altitude view - color based on height
            var altitudeColor = getAltitudeColor(cube.position.y);
            cube.material.color.copy(altitudeColor);
        } else if (currentViewMode === 'debug') {
            // Debug view - distinct color for stitching blocks
            cube.material.color.setHex(0xff00ff); // Magenta for stitching
        }
        
        // Reduced rotation for stitching blocks
        if (userData.step <= 2) {
            cube.rotation.x = avgWaveHeight * 0.1;
            cube.rotation.z = avgWaveHeight * 0.05;
        }
        
        // Subtle mouse highlight - optimized distance calculation
        var dx = gridX - mouseGridX;
        var dz = gridZ - mouseGridY;
        var distanceSquared = dx * dx + dz * dz;
        var threshold = userData.step * 2;
        
        if (distanceSquared < threshold * threshold) {
            cube.material.emissive.setHex(0x111111); // Very subtle glow
        } else {
            cube.material.emissive.setHex(0x000000);
        }
    }
}

function animate() {
    requestAnimationFrame(animate);
    
    // Update controls
    controls.update();
    
    // Update wave simulation
    updateWaves();
    
    // Update 3D grid
    updateGrid();
    
    // Render scene
    renderer.render(scene, camera);
}

// Slider controls
function initSliders() {
    // Damping slider
    var dampingSlider = document.getElementById('dampingSlider');
    var dampingValue = document.getElementById('dampingValue');
    
    dampingSlider.addEventListener('input', function() {
        damping = parseFloat(this.value);
        dampingValue.textContent = damping.toFixed(2);
    });
    
    // Mouse influence slider
    var mouseInfluenceSlider = document.getElementById('mouseInfluenceSlider');
    var mouseInfluenceValue = document.getElementById('mouseInfluenceValue');
    
    mouseInfluenceSlider.addEventListener('input', function() {
        mouseInfluence = parseFloat(this.value);
        mouseInfluenceValue.textContent = mouseInfluence;
    });
    
    // Resolution slider
    var resSlider = document.getElementById('resSlider');
    var resValue = document.getElementById('resValue');
    
    resSlider.addEventListener('input', function() {
        var newRes = parseInt(this.value);
        resValue.textContent = newRes;
        
        if (newRes !== res) {
            res = newRes;
            // Recreate the grid and buffers with new resolution
            recreateGridWithNewResolution();
        }
    });
    
    // View mode dropdown
    var viewModeSelect = document.getElementById('viewMode');
    
    viewModeSelect.addEventListener('change', function() {
        currentViewMode = this.value;
        console.log("View mode changed to:", currentViewMode);
    });
}


function recreateGridWithNewResolution() {
    // Clear existing grid
    for (var i = 0; i < grid.length; i++) {
        scene.remove(grid[i]);
    }
    grid = [];
    
    // Clear stitching blocks
    for (var i = 0; i < stitchingBlocks.length; i++) {
        scene.remove(stitchingBlocks[i]);
    }
    stitchingBlocks = [];
    
    // Clear perimeter blocks
    for (var i = 0; i < perimeterBlocks.length; i++) {
        scene.remove(perimeterBlocks[i]);
    }
    perimeterBlocks = [];
    
    // Clear all caches (resolution changed)
    geometryCache = {};
    materialCache = {};
    
    // Reinitialize wave buffers with new resolution
    buffer1 = [];
    buffer2 = [];
    temp = [];
    for (var i = 0; i < res * res; i++) {
        buffer1[i] = 0;  // current state
        buffer2[i] = 0;  // previous state
        temp[i] = 0;     // next state (working buffer)
    }
    
    // Update plane size
    scene.remove(plane);
    var planeGeometry = new THREE.PlaneGeometry(res * size, res * size);
    var planeMaterial = new THREE.MeshBasicMaterial({ visible: false });
    plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    scene.add(plane);
    
    // Reset mouse grid position to center
    mouseGridX = Math.floor(res / 2);
    mouseGridY = Math.floor(res / 2);
    
    // Recreate the jello grid
    createJelloGrid();
    
    // Recreate perimeter
    createPerimeter();
    
    console.log("Grid recreated with resolution:", res, "x", res, "=", res * res, "blocks");
}

// Start the simulation
init();

// Initialize sliders after DOM is loaded
window.addEventListener('load', function() {
    initSliders();
});
