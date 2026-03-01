import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface OritoAvatarProps {
    state?: AvatarState;
    size?: number;
}

//------This Component renders Orito's 3D low-poly avatar---------
export default function OritoAvatar({ state = 'idle', size = 200 }: OritoAvatarProps) {
    const stateRef = useRef<AvatarState>(state);
    const rafRef = useRef<number | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const meshRef = useRef<THREE.Mesh | null>(null);
    const particlesRef = useRef<THREE.Points | null>(null);
    const clockRef = useRef(new THREE.Clock());

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    //------This Function handles the GL context creation---------
    const onContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
        const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;

        // Scene
        const scene = new THREE.Scene();
        scene.background = null;

        // Camera
        const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100);
        camera.position.set(0, 0, 3);

        // Renderer using ExpoGL context
        const renderer = new THREE.WebGLRenderer({
            // @ts-ignore
            canvas: { width: w, height: h },
            context: gl as unknown as WebGLRenderingContext,
            antialias: true,
            alpha: true,
        });
        renderer.setSize(w, h);
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(1);
        rendererRef.current = renderer;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0x8855ff, 0.6);
        scene.add(ambientLight);

        const pointLight1 = new THREE.PointLight(0x00ffff, 2.5, 10);
        pointLight1.position.set(2, 2, 2);
        scene.add(pointLight1);

        const pointLight2 = new THREE.PointLight(0xff00ff, 1.5, 10);
        pointLight2.position.set(-2, -1, 1);
        scene.add(pointLight2);

        // ── Build low-poly avatar head from icosahedron ──────────────────────
        const headGeo = new THREE.IcosahedronGeometry(0.85, 1);

        // Distort vertices slightly for a hand-crafted poly look
        const pos = headGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const z = pos.getZ(i);
            const noise = 0.08 * (Math.random() - 0.5);
            pos.setXYZ(i, x + noise, y + noise, z + noise);
        }
        headGeo.computeVertexNormals();

        const headMat = new THREE.MeshPhongMaterial({
            color: 0x1a1a2e,
            emissive: 0x0d0d1a,
            specular: 0x00ffff,
            shininess: 80,
            wireframe: false,
            transparent: true,
            opacity: 0.92,
            flatShading: true,
        });
        const head = new THREE.Mesh(headGeo, headMat);
        scene.add(head);
        meshRef.current = head;

        // Wireframe overlay
        const wireMat = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            wireframe: true,
            transparent: true,
            opacity: 0.15,
        });
        const wireframe = new THREE.Mesh(headGeo, wireMat);
        scene.add(wireframe);

        // ── Eyes ─────────────────────────────────────────────────────────────
        const eyeGeo = new THREE.SphereGeometry(0.09, 8, 8);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });

        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.26, 0.16, 0.76);
        scene.add(leftEye);

        const rightEye = new THREE.Mesh(eyeGeo, eyeMat.clone());
        rightEye.position.set(0.26, 0.16, 0.76);
        scene.add(rightEye);

        // Eye glow rings
        const ringGeo = new THREE.RingGeometry(0.09, 0.15, 16);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
        const leftRing = new THREE.Mesh(ringGeo, ringMat);
        leftRing.position.copy(leftEye.position);
        leftRing.position.z += 0.01;
        scene.add(leftRing);

        const rightRing = new THREE.Mesh(ringGeo, ringMat.clone());
        rightRing.position.copy(rightEye.position);
        rightRing.position.z += 0.01;
        scene.add(rightRing);

        // ── Floating particles ────────────────────────────────────────────────
        const PARTICLE_COUNT = 120;
        const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
        const particleSpeeds = new Float32Array(PARTICLE_COUNT);
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = 1.3 + Math.random() * 0.8;
            particlePositions[i * 3]     = Math.cos(angle) * radius;
            particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 2;
            particlePositions[i * 3 + 2] = Math.sin(angle) * radius;
            particleSpeeds[i] = 0.3 + Math.random() * 0.7;
        }
        const particleGeo = new THREE.BufferGeometry();
        particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
        const particleMat = new THREE.PointsMaterial({ color: 0x88aaff, size: 0.04, transparent: true, opacity: 0.7 });
        const particles = new THREE.Points(particleGeo, particleMat);
        scene.add(particles);
        particlesRef.current = particles;

        // ── Animation loop ────────────────────────────────────────────────────
        let t = 0;
        const animate = () => {
            rafRef.current = requestAnimationFrame(animate);
            const dt = clockRef.current.getDelta();
            t += dt;

            const s = stateRef.current;

            // Head rotation and bob
            if (s === 'listening') {
                head.rotation.y = Math.sin(t * 1.5) * 0.25;
                head.rotation.x = Math.sin(t * 0.8) * 0.08;
                head.scale.setScalar(1.0 + Math.sin(t * 4) * 0.015);
            } else if (s === 'thinking') {
                head.rotation.y += dt * 1.2;
                head.rotation.x = Math.sin(t * 1.2) * 0.12;
                head.scale.setScalar(1.0);
            } else if (s === 'speaking') {
                head.rotation.y = Math.sin(t * 2.0) * 0.18;
                head.rotation.x = Math.sin(t * 3.0) * 0.06;
                head.scale.setScalar(1.0 + Math.abs(Math.sin(t * 6)) * 0.03);
            } else {
                // Idle – gentle float
                head.rotation.y = Math.sin(t * 0.4) * 0.12;
                head.rotation.x = Math.sin(t * 0.3) * 0.04;
                head.position.y = Math.sin(t * 0.6) * 0.04;
                head.scale.setScalar(1.0);
            }
            wireframe.rotation.copy(head.rotation);
            wireframe.position.copy(head.position);
            wireframe.scale.copy(head.scale);

            // Eye pulse
            const eyePulse = 0.85 + Math.abs(Math.sin(t * 1.5)) * 0.3;
            (leftEye.material as THREE.MeshBasicMaterial).color.setHSL(
                s === 'listening' ? 0.5 : s === 'thinking' ? 0.75 : 0.5,
                1, eyePulse * 0.5
            );
            (rightEye.material as THREE.MeshBasicMaterial).color.copy(
                (leftEye.material as THREE.MeshBasicMaterial).color
            );

            // Particle orbit
            const pPos = particleGeo.attributes.position as THREE.BufferAttribute;
            const speed = s === 'listening' ? 0.8 : s === 'thinking' ? 1.5 : s === 'speaking' ? 1.2 : 0.4;
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                const px = pPos.getX(i);
                const pz = pPos.getZ(i);
                const a = Math.atan2(pz, px) + dt * particleSpeeds[i] * speed;
                const r = Math.sqrt(px * px + pz * pz);
                pPos.setX(i, Math.cos(a) * r);
                pPos.setZ(i, Math.sin(a) * r);
                pPos.setY(i, pPos.getY(i) + Math.sin(t + i) * dt * 0.15);
            }
            pPos.needsUpdate = true;

            // Light colour by state
            const lCol = s === 'listening' ? 0x00ffff : s === 'thinking' ? 0xaa00ff : s === 'speaking' ? 0xff88ff : 0x00ffff;
            pointLight1.color.setHex(lCol);

            renderer.render(scene, camera);
            // @ts-ignore
            gl.endFrameEXP();
        };
        animate();
    }, []);

    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rendererRef.current?.dispose();
        };
    }, []);

    return (
        <View style={[styles.container, { width: size, height: size }]}>
            <GLView
                style={{ width: size, height: size }}
                onContextCreate={onContextCreate}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderRadius: 999,
        overflow: 'hidden',
    },
});
