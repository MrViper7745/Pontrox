import cadquery as cq

part = (
    cq.Workplane("XY")
    .box(60, 40, 20)
    .faces(">Z").workplane().hole(10)
    .edges("|Z").fillet(3)
)
cq.exporters.export(part, "tests/out/cq_test.step")
cq.exporters.export(part, "tests/out/cq_test.stl")
print("ok")