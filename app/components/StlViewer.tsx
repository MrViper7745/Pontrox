"use client";

import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Center, Bounds } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

function Model({ data }: { data: ArrayBuffer }) {
  const geometry = useMemo(() => {
    const g = new STLLoader().parse(data);
    g.computeVertexNormals();
    return g;
  }, [data]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#4f8ef7" roughness={0.5} metalness={0.1} />
    </mesh>
  );
}

export default function StlViewer({ data }: { data: ArrayBuffer | ArrayBuffer[] | null }) {
  const list = data ? (Array.isArray(data) ? data : [data]) : [];
  return (
    <Canvas camera={{ position: [120, 100, 120], fov: 45 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[60, 120, 60]} intensity={1.4} />
      <directionalLight position={[-60, -40, -60]} intensity={0.4} />
      {list.length > 0 && (
        <Bounds fit clip observe margin={1.5}>
          <Center>
            {/* The CAD files use Z as up, three.js uses Y */}
            <group rotation={[-Math.PI / 2, 0, 0]}>
              {list.map((d, i) => (
                <Model key={i} data={d} />
              ))}
            </group>
          </Center>
        </Bounds>
      )}
      <OrbitControls makeDefault />
    </Canvas>
  );
}