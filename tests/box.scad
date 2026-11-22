// Parametric box
length = 60;   // [20:5:200]
width  = 40;   // [20:5:150]
height = 25;   // [10:5:100]
wall   = 2;    // [1:0.5:6]

difference() {
    cube([length, width, height]);
    translate([wall, wall, wall])
        cube([length - 2*wall, width - 2*wall, height]);
}
