"use client";

import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Bounds, Edges } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { DoubleSide } from "three";

function Model({ data, edges }: { data: ArrayBuffer; edges: boolean }) {
  const geometry = useMemo(() => {
    const g = new STLLoader().parse(data);
    g.computeVertexNormals();
    return g;
  }, [data]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#4f8ef7" roughness={0.5} metalness={0.1} />
      {edges && <Edges threshold={25} color="#0b2a66" />}
    </mesh>
  );
}

export default function StlViewer({
  data,
  bed,
  edges,
}: {
  data: ArrayBuffer[] | null;
  bed: { w: number; d: number } | null;
  edges: boolean;
}) {
  const list = data ?? [];
  return (
    <Canvas camera={{ position: [120, 100, 120], fov: 45 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[60, 120, 60]} intensity={1.4} />
      <directionalLight position={[-60, -40, -60]} intensity={0.4} />
      {list.length > 0 && (
        <Bounds fit clip observe margin={1.5}>
          {/* The CAD files use Z as up, three.js uses Y. Parts sit at the bed's corner. */}
          <group rotation={[-Math.PI / 2, 0, 0]}>
            {bed && (
              <mesh position={[bed.w / 2, bed.d / 2, -0.3]}>
                <planeGeometry args={[bed.w, bed.d]} />
                <meshStandardMaterial color="#e5e7eb" side={DoubleSide} />
                <Edges color="#6b7280" />
              </mesh>
            )}
            {list.map((d, i) => (
              <Model key={i} data={d} edges={edges} />
            ))}
          </group>
        </Bounds>
      )}
      <OrbitControls makeDefault />
    </Canvas>
  );
}