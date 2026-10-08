/**
 * 天穹。
 *
 * 为什么要单独做一个：**纯色背景是「背景和城池分不开」的根源**。
 * 一块均匀的蓝灰，和青瓦屋顶的明度、色相都太接近，剪影就沉进去了。
 * 真实的天空从来不是一个颜色 —— 顶上深、近地平线浅而暖，
 * 这道渐变本身就把建筑的轮廓托了出来。
 */
import * as THREE from 'three';

/**
 * 一张画出来的天，直接拿去做 `scene.background`。
 *
 * **为什么不用下面那个天穹：** 天穹是一个半径一个单位的球，
 * 透视相机在球心里，它铺满全屏；而**正交相机**下它只投影出一个点，
 * 屏幕其余部分就是清屏色 —— 黑的。
 * 这个项目里的场景全是正交的，所以真正管用的是这张贴图。
 *
 * 顶上偏冷的青，往下渐次转暖转亮，到地平线是一层浅金 ——
 * 深色的远山与军阵压在浅色的天上，剪影才立得住。
 */
export function skyTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#4d7086');
  grad.addColorStop(0.34, '#7d9aab');
  grad.addColorStop(0.62, '#b3bcbb');
  grad.addColorStop(0.84, '#d8cfb8');
  grad.addColorStop(1, '#e2d3b4');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // 天穹跟着相机走，永远不会被穿出去
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const FRAG = /* glsl */`
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 groundColor;
  /** 地平线上下的过渡宽度 */
  uniform float softness;
  varying vec3 vDir;

  void main() {
    float h = vDir.y;
    // 地平线以上：往顶上渐深
    float up = smoothstep(0.0, 0.62, h);
    vec3 sky = mix(horizonColor, topColor, pow(up, 0.8));
    // 地平线以下：压成远处地面的颜色，免得出现一条硬边
    float down = smoothstep(0.0, -softness, h);
    gl_FragColor = vec4(mix(sky, groundColor, down), 1.0);
  }
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: {
    topColor: { value: THREE.Color };
    horizonColor: { value: THREE.Color };
    groundColor: { value: THREE.Color };
    softness: { value: number };
  };

  constructor() {
    this.uniforms = {
      topColor: { value: new THREE.Color(0x74909f) },
      horizonColor: { value: new THREE.Color(0xcac5b8) },
      groundColor: { value: new THREE.Color(0x8c8576) },
      softness: { value: 0.22 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
    this.mesh.frustumCulled = false;
    // 最先画，且不写深度，所以永远在最后面
    this.mesh.renderOrder = -1000;
  }

  /** 设定三段颜色。返回地平线色，供雾使用 —— 两者必须一致，否则远景会脱节 */
  set(top: THREE.ColorRepresentation, horizon: THREE.ColorRepresentation,
      ground: THREE.ColorRepresentation): THREE.Color {
    this.uniforms.topColor.value.set(top);
    this.uniforms.horizonColor.value.set(horizon);
    this.uniforms.groundColor.value.set(ground);
    return this.uniforms.horizonColor.value;
  }

  setRGB(
    top: [number, number, number],
    horizon: [number, number, number],
    ground: [number, number, number],
  ): THREE.Color {
    this.uniforms.topColor.value.setRGB(top[0], top[1], top[2]);
    this.uniforms.horizonColor.value.setRGB(horizon[0], horizon[1], horizon[2]);
    this.uniforms.groundColor.value.setRGB(ground[0], ground[1], ground[2]);
    return this.uniforms.horizonColor.value;
  }

  get horizon(): THREE.Color {
    return this.uniforms.horizonColor.value;
  }
}
