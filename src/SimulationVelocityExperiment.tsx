import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Play, 
  RotateCcw, 
  Table as TableIcon, 
  Info, 
  ChevronRight, 
  Activity,
  Ruler,
  Timer,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Các hằng số vật lý ---
const G = 9.81; // m/s^2
const PIXELS_PER_METER = 400;
const INCLINE_LENGTH = 0.6; // 60cm máng nghiêng
const HORIZONTAL_LENGTH = 1.4; // 140cm máng ngang
const FRICTION_COEFF_INCLINE = 0.01; 
const FRICTION_COEFF_HORIZONTAL = 0; // Chuyển động thẳng đều trên máng ngang

type Measurement = {
  id: number;
  tA: number;
  vA: number;
};

type DiameterMeasurement = {
  id: number;
  value: number;
};

// --- Thành phần chính của ứng dụng ---

export default function SimulationVelocityExperiment() {
  // --- Khởi tạo State ---
  const [diameterMeasurements, setDiameterMeasurements] = useState<DiameterMeasurement[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [isSimulating, setIsSimulating] = useState(false);
  const isSimulatingRef = useRef(false);
  const [ballPos, setBallPos] = useState(0); // m (tổng quãng đường dọc theo máng)
  const [ballVel, setBallVel] = useState(0); // m/s
  const [currentTime, setCurrentTime] = useState(0); // s
  const [trackAngle, setTrackAngle] = useState(45); // Tăng góc mặc định lên 45 độ

  // Refs cho mô phỏng vật lý (để tránh stale closures và đồng bộ hóa tốt hơn)
  const ballPosRef = useRef(0);
  const ballVelRef = useRef(0);
  const currentTimeSimRef = useRef(0);
  
  // Vị trí cổng quang (tính từ điểm bắt đầu máng ngang)
  const [gateAPos, setGateAPos] = useState(0.4); // 40cm trên máng ngang
  
  const caliperCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const [tA, setTA] = useState<number | null>(null);
  
  const [isBlockingA, setIsBlockingA] = useState(false);
  const isBlockingARef = useRef(false);
  const [isBallOnTrack, setIsBallOnTrack] = useState(true);
  const [isBallInCaliper, setIsBallInCaliper] = useState(true);
  const [caliperValue, setCaliperValue] = useState(40); // Bắt đầu từ 40 (chạm bi)
  const [userCaliperInput, setUserCaliperInput] = useState("");
  const [showCaliperHint, setShowCaliperHint] = useState(false);
  const [magOffset, setMagOffset] = useState({ x: 0, y: 0 });
  const [isDraggingMag, setIsDraggingMag] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showCaliperGuide, setShowCaliperGuide] = useState(false);
  const isDraggingCaliper = useRef(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(null);
  const startTimeRef = useRef<number>(null);
  
  const blockAStartRef = useRef<number | null>(null);
  const passAStartRef = useRef<number | null>(null);

  // --- Tính toán các giá trị trung bình và sai số ---
  const statsDiameter = useMemo(() => {
    if (diameterMeasurements.length === 0) return { avg: 0, avgDeltaD: 0, error: 0 };
    const values = diameterMeasurements.map(m => m.value / 10); // Đổi sang cm
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const deltaDi = values.map(v => Math.abs(v - avg));
    const avgDeltaD = deltaDi.reduce((a, b) => a + b, 0) / values.length;
    const instrumentError = 0.005; // 0.05mm = 0.005cm (theo hình)
    return { avg, avgDeltaD, error: avgDeltaD + instrumentError };
  }, [diameterMeasurements]);

  const statsTime = useMemo(() => {
    const valid = measurements.map(m => m.tA);
    if (valid.length === 0) return { avg: 0, avgDeltaT: 0, error: 0 };
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    const deltaTi = valid.map(v => Math.abs(v - avg));
    const avgDeltaT = deltaTi.reduce((a, b) => a + b, 0) / valid.length;
    const instrumentError = 0.0005; // 0.0005s (theo hình)
    return { avg, avgDeltaT, error: avgDeltaT + instrumentError };
  }, [measurements]);

  const vA_cm_s = useMemo(() => {
    if (statsTime.avg === 0 || statsDiameter.avg === 0) return 0;
    return statsDiameter.avg / statsTime.avg;
  }, [statsTime.avg, statsDiameter.avg]);

  const deltaV = useMemo(() => {
    if (vA_cm_s === 0) return 0;
    // Sai số gián tiếp: Δv/v = Δd/d + Δt/t
    return vA_cm_s * (statsDiameter.error / statsDiameter.avg + statsTime.error / statsTime.avg);
  }, [vA_cm_s, statsDiameter, statsTime]);

  const vA = vA_cm_s / 100; // m/s cho mô phỏng
  const avgTA = statsTime.avg;
  const avgDiameter = statsDiameter.avg === 0 ? 40 : statsDiameter.avg * 10; // mm cho mô phỏng

  // --- Logic Vật lý ---
  const animate = (time: number) => {
    if (!startTimeRef.current) startTimeRef.current = time;
    const dt = (time - startTimeRef.current) / 1000;
    startTimeRef.current = time;
    const effectiveDt = Math.min(dt, 0.032);

    const angleRad = trackAngle * (Math.PI / 180);
    let acceleration = 0;
    
    if (ballPosRef.current < INCLINE_LENGTH) {
      // Trên đoạn nghiêng: Nhanh dần đều
      acceleration = G * (Math.sin(angleRad) - FRICTION_COEFF_INCLINE * Math.cos(angleRad));
    } else {
      // Trên đoạn ngang: Thẳng đều (nếu ma sát = 0)
      acceleration = -G * FRICTION_COEFF_HORIZONTAL;
    }

    // Cập nhật vận tốc và vị trí (Sử dụng refs để tính toán chính xác)
    const oldVel = ballVelRef.current;
    const newVel = Math.max(0, oldVel + acceleration * effectiveDt);
    const newPos = ballPosRef.current + oldVel * effectiveDt + 0.5 * acceleration * effectiveDt * effectiveDt;
    
    ballVelRef.current = newVel;
    ballPosRef.current = newPos;
    currentTimeSimRef.current += effectiveDt;

    // Cập nhật state để render
    setBallPos(newPos);
    setBallVel(newVel);
    setCurrentTime(currentTimeSimRef.current);

    const frontEdge = newPos;
    const backEdge = newPos - avgDiameter / 1000;

    // Cổng quang A (vị trí trên máng ngang)
    const absGateA = INCLINE_LENGTH + gateAPos;
    const currentlyBlockingA = frontEdge >= absGateA && backEdge <= absGateA;
    
    if (currentlyBlockingA && !isBlockingARef.current) {
      isBlockingARef.current = true;
      setIsBlockingA(true);
      blockAStartRef.current = time;
      passAStartRef.current = time;
    } else if (!currentlyBlockingA && isBlockingARef.current) {
      isBlockingARef.current = false;
      setIsBlockingA(false);
      const duration = (time - (blockAStartRef.current || time)) / 1000;
      setTA(duration);
    }

    // Dừng lại khi hết máng
    if (newPos > INCLINE_LENGTH + HORIZONTAL_LENGTH) {
      setIsSimulating(false);
      isSimulatingRef.current = false;
      return;
    }

    if (isSimulatingRef.current) {
      requestRef.current = requestAnimationFrame(animate);
    }
  };

  useEffect(() => {
    if (isSimulating) {
      startTimeRef.current = null;
      requestRef.current = requestAnimationFrame(animate);
    } else if (requestRef.current) {
      cancelAnimationFrame(requestRef.current);
      // Ghi lại kết quả sau khi kết thúc lượt chạy - Chỉ ghi khi đã qua cổng A
      if (tA && tA > 0) {
        setMeasurements(prev => {
          if (prev.length >= 5) return prev;
          const currentVA = (avgDiameter / 1000) / tA;
          return [...prev, { 
            id: Date.now(), 
            tA: tA, 
            vA: currentVA
          }];
        });
      }
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isSimulating]);

  // --- Handlers ---
  const handleStart = () => {
    if (!isBallOnTrack) {
      alert("Vui lòng đặt bi vào máng trước khi bắt đầu.");
      return;
    }
    if (diameterMeasurements.length < 5) {
      alert("Vui lòng đo đường kính bi 5 lần trước.");
      return;
    }
    ballPosRef.current = 0;
    ballVelRef.current = 0;
    currentTimeSimRef.current = 0;
    
    setBallPos(0);
    setBallVel(0);
    setCurrentTime(0);
    setTA(null);
    setIsBlockingA(false);
    isBlockingARef.current = false;
    setIsSimulating(true);
    isSimulatingRef.current = true;
  };

  const handleReset = () => {
    setIsSimulating(false);
    isSimulatingRef.current = false;
    ballPosRef.current = 0;
    ballVelRef.current = 0;
    currentTimeSimRef.current = 0;
    
    setBallPos(0);
    setBallVel(0);
    setCurrentTime(0);
    setTA(null);
    setIsBlockingA(false);
    isBlockingARef.current = false;
  };

  const addDiameterMeasurement = () => {
    if (diameterMeasurements.length >= 5) return;
    
    if (!isBallInCaliper) {
      alert("Vui lòng đặt bi vào thước để đo!");
      return;
    }

    const inputVal = parseFloat(userCaliperInput);
    if (isNaN(inputVal)) {
      alert("Vui lòng nhập giá trị đo được!");
      return;
    }

    setDiameterMeasurements(prev => [...prev, { id: Date.now(), value: inputVal }]);
    setUserCaliperInput("");
  };

  const clearMeasurements = () => {
    if (confirm("Xóa toàn bộ dữ liệu?")) {
      setDiameterMeasurements([]);
      setMeasurements([]);
      handleReset();
    }
  };

  // --- Vẽ Thước kẹp ---
  useEffect(() => {
    const canvas = caliperCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scale = 5; 
    const offsetX = 60;
    const offsetY = 80;

    const handleMouseDown = (e: MouseEvent | TouchEvent) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      const x = (clientX - rect.left) * (canvas.width / rect.width);
      const y = (clientY - rect.top) * (canvas.height / rect.height);

      // Kiểm tra xem có đang nhấn vào kính lúp không
      const slideX = offsetX + caliperValue * scale;
      const baseMagX = Math.max(100, Math.min(canvas.width - 100, slideX + 40));
      const magX = baseMagX + magOffset.x;
      const magY = 160 + magOffset.y;
      const dist = Math.sqrt((x - magX) ** 2 + (y - magY) ** 2);
      
      if (dist < 75) {
        setIsDraggingMag(true);
        return;
      }

      // Kiểm tra xem có nhấn vào phần trượt không
      if (x >= slideX - 20 && x <= slideX + 60) {
        isDraggingCaliper.current = true;
      }
    };

    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      const x = (clientX - rect.left) * (canvas.width / rect.width);
      const y = (clientY - rect.top) * (canvas.height / rect.height);

      if (isDraggingMag) {
        const slideX = offsetX + caliperValue * scale;
        const baseMagX = Math.max(100, Math.min(canvas.width - 100, slideX + 40));
        const baseMagY = 160;
        setMagOffset({
          x: x - baseMagX,
          y: y - baseMagY
        });
        return;
      }

      if (!isDraggingCaliper.current) return;
      
      let newValue = (x - offsetX) / scale;
      
      // Giới hạn vật lý: Nếu có bi thì không thể đóng thước nhỏ hơn 40mm
      if (isBallInCaliper && newValue < 40) {
        newValue = 40;
      }

      // Làm tròn đến 0.05mm để khớp với vạch chia du xích
      newValue = Math.round(newValue * 20) / 20;
      newValue = Math.max(0, Math.min(80, newValue));
      setCaliperValue(newValue);
    };

    const handleMouseUp = () => {
      isDraggingCaliper.current = false;
      setIsDraggingMag(false);
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('touchstart', handleMouseDown);
    window.addEventListener('touchmove', handleMouseMove);
    window.addEventListener('touchend', handleMouseUp);

    const drawCaliper = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Hiệu ứng kim loại cho thước
      const metalGrad = ctx.createLinearGradient(0, offsetY - 20, 0, offsetY + 20);
      metalGrad.addColorStop(0, '#f8fafc');
      metalGrad.addColorStop(0.2, '#e2e8f0');
      metalGrad.addColorStop(0.5, '#cbd5e1');
      metalGrad.addColorStop(0.8, '#94a3b8');
      metalGrad.addColorStop(1, '#475569');

      // 1. Vẽ thân thước (Main Scale)
      ctx.save();
      ctx.fillStyle = metalGrad;
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 3;
      
      // Bo góc nhẹ cho thân thước
      const r = 4;
      ctx.beginPath();
      ctx.roundRect(offsetX, offsetY - 20, 420, 40, r);
      ctx.fill();
      ctx.restore();
      
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(offsetX, offsetY - 20, 420, 40);
      
      // Vạch chia trên thân thước (mm)
      ctx.fillStyle = '#0f172a';
      for (let i = 0; i <= 80; i++) {
        const x = offsetX + i * scale;
        const height = i % 10 === 0 ? 22 : (i % 5 === 0 ? 15 : 10);
        ctx.fillRect(x, offsetY - 20, 1.2, height);
        if (i % 10 === 0) {
          ctx.font = 'bold 14px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText((i/10).toString(), x, offsetY - 25); // Chuyển lên trên để không bị che
        }
      }
      ctx.font = 'italic bold 12px Inter';
      ctx.fillText('cm', offsetX + 410, offsetY - 25);

      // Hàm cố định (Fixed Jaw)
      ctx.save();
      ctx.fillStyle = metalGrad;
      ctx.shadowColor = 'rgba(0,0,0,0.2)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = -2;
      ctx.beginPath();
      ctx.moveTo(offsetX, offsetY - 20);
      ctx.lineTo(offsetX - 45, offsetY - 20);
      ctx.lineTo(offsetX - 45, offsetY + 120);
      ctx.lineTo(offsetX - 10, offsetY + 120);
      ctx.lineTo(offsetX, offsetY + 20);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.stroke();
      ctx.restore();

      // 2. Vẽ viên bi (Ball) - Mẫu để học sinh đo
      if (isBallInCaliper) {
        const ballD = 40; // Đường kính bi mẫu 40mm
        const ballRadius = (ballD / 2) * scale;
        const ballX = offsetX + ballRadius;
        const ballY = offsetY + 70;

        ctx.save();
        const ballGrad = ctx.createRadialGradient(ballX - ballRadius/3, ballY - ballRadius/3, ballRadius/10, ballX, ballY, ballRadius);
        ballGrad.addColorStop(0, '#ff8888');
        ballGrad.addColorStop(0.7, '#cc0000');
        ballGrad.addColorStop(1, '#660000');
        ctx.fillStyle = ballGrad;
        ctx.beginPath();
        ctx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
        ctx.fill();
        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.arc(ballX - ballRadius/2.5, ballY - ballRadius/2.5, ballRadius/4, 0, Math.PI * 2);
        ctx.fill();
        
        // Nhãn cho bi mẫu
        ctx.fillStyle = '#475569';
        ctx.font = 'italic 10px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('Viên bi thép mẫu', ballX, ballY + ballRadius + 15);
        
        ctx.restore();
      }
      
      // 3. Vẽ hàm động (Sliding Jaw)
      const slideX = offsetX + caliperValue * scale;
      
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = -4;
      
      ctx.fillStyle = metalGrad;
      // Khung trượt
      ctx.beginPath();
      ctx.roundRect(slideX - 25, offsetY - 28, 90, 56, 4);
      ctx.fill();
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      
      // Hàm động
      ctx.beginPath();
      ctx.moveTo(slideX, offsetY + 20);
      ctx.lineTo(slideX, offsetY + 120);
      ctx.lineTo(slideX + 35, offsetY + 120);
      ctx.lineTo(slideX + 45, offsetY + 20);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Vạch chia trên du xích (Vernier Scale - 0.05mm precision)
      // 20 vạch du xích tương đương 19mm trên thước chính
      ctx.fillStyle = '#0f172a';
      for (let i = 0; i <= 20; i++) {
        const x = slideX + i * (scale * 0.95);
        const h = i % 10 === 0 ? 14 : (i % 5 === 0 ? 10 : 7);
        ctx.fillRect(x, offsetY - 20, 1.2, h);
        if (i % 2 === 0) {
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText((i/2).toString(), x, offsetY - 24);
        }
      }

      // 4. Vẽ Kính lúp (Magnifier) - Có thể kéo thả
      const baseMagX = Math.max(100, Math.min(w - 100, slideX + 40));
      const baseMagY = 160;
      const magX = baseMagX + magOffset.x;
      const magY = baseMagY + magOffset.y;
      const magSize = 75;
      
      // Đèn báo chạm (Đã gỡ bỏ vì không còn bi mẫu)

      ctx.save();
      // Vẽ cán kính lúp
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(magX, magY + magSize - 5);
      ctx.lineTo(magX + 40, magY + magSize + 30);
      ctx.stroke();

      // Viền ngoài kính lúp (khung kim loại)
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(magX, magY, magSize, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(magX, magY, magSize - 3, 0, Math.PI * 2);
      ctx.clip();
      
      // Vẽ nền kính lúp (hơi ngả xanh kính)
      ctx.fillStyle = '#f0f9ff';
      ctx.fillRect(magX - magSize, magY - magSize, magSize * 2, magSize * 2);
      
      // Vẽ nội dung phóng đại (phóng đại 3 lần)
      const zoom = 3;
      ctx.translate(magX - slideX * zoom, magY - (offsetY - 15) * zoom);
      ctx.scale(zoom, zoom);
      
      // Vẽ lại vạch thân chính trong kính lúp
      ctx.fillStyle = '#475569';
      for (let i = 0; i <= 80; i++) {
        const x = offsetX + i * scale;
        const h = i % 10 === 0 ? 15 : 8;
        ctx.fillRect(x, offsetY - 20, 0.6, h);
        
        // Vẽ cả số trong kính lúp
        if (i % 10 === 0) {
          ctx.font = 'bold 6px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText((i/10).toString(), x, offsetY - 25);
        }
      }
      
      // Vẽ lại vạch du xích trong kính lúp (Màu đỏ để dễ quan sát sự trùng khớp)
      ctx.fillStyle = '#ef4444';
      for (let i = 0; i <= 20; i++) {
        const x = slideX + i * (scale * 0.95);
        const h = i % 10 === 0 ? 14 : (i % 5 === 0 ? 10 : 7);
        ctx.fillRect(x, offsetY - 20, 0.6, h);
      }
      
      // Đánh dấu vạch trùng khớp (nếu có)
      const alignedIndex = Math.round((caliperValue % 1) * 20);
      if (alignedIndex >= 0 && alignedIndex <= 20) {
        const alignX = slideX + alignedIndex * (scale * 0.95);
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(alignX, offsetY - 25);
        ctx.lineTo(alignX, offsetY + 20);
        ctx.stroke();
      }
      
      ctx.restore();
      
      // Hiệu ứng phản chiếu trên mặt kính
      const glassGrad = ctx.createRadialGradient(magX - 30, magY - 30, 10, magX, magY, magSize);
      glassGrad.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      glassGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.1)');
      glassGrad.addColorStop(1, 'rgba(186, 230, 253, 0.2)');
      
      ctx.fillStyle = glassGrad;
      ctx.beginPath();
      ctx.arc(magX, magY, magSize - 3, 0, Math.PI * 2);
      ctx.fill();
      
      // Vạch chỉ thị tâm kính lúp
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(magX, magY - magSize + 10);
      ctx.lineTo(magX, magY + magSize - 10);
      ctx.stroke();
      ctx.setLineDash([]);

      // Vít hãm (Locking Screw) - Vẽ tĩnh
      const lockX = slideX + 10;
      const lockY = offsetY - 35;
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.roundRect(lockX - 8, lockY, 16, 10, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 7px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('LOCK', lockX, lockY + 7);

      // Nút cầm kéo (Thumb screw)
      const screwX = slideX + 55;
      const screwY = offsetY + 15;
      const screwGrad = ctx.createRadialGradient(screwX, screwY, 2, screwX, screwY, 12);
      screwGrad.addColorStop(0, '#94a3b8');
      screwGrad.addColorStop(1, '#1e293b');
      ctx.fillStyle = screwGrad;
      ctx.beginPath();
      ctx.arc(screwX, screwY, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.stroke();
      
      // Ký hiệu mũi tên trên nút
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('↔', screwX, screwY + 4);
    };

    drawCaliper();

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('touchstart', handleMouseDown);
      window.removeEventListener('touchmove', handleMouseMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [caliperValue, magOffset, isBallInCaliper]);

  // --- Vẽ Canvas ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Nền phòng thí nghiệm
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, w, h);
      
      // Vẽ lưới mờ
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 0.5;
      for(let i=0; i<w; i+=50) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
      }
      for(let i=0; i<h; i+=50) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke();
      }

      const startX = 50;
      const startY = 100;
      const angleRad = trackAngle * (Math.PI / 180);

      const inclineEndX = startX + INCLINE_LENGTH * PIXELS_PER_METER * Math.cos(angleRad);
      const inclineEndY = startY + INCLINE_LENGTH * PIXELS_PER_METER * Math.sin(angleRad);
      const horizontalEndX = inclineEndX + HORIZONTAL_LENGTH * PIXELS_PER_METER;

      // 1. Vẽ chân đế (Laboratory Stands) - Vẽ trước để nằm dưới máng
      const drawStand = (x: number, y: number, height: number) => {
        // Đế stand
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        ctx.roundRect(x - 30, y + height - 10, 60, 15, 4);
        ctx.fill();
        
        // Thanh đứng kim loại
        const metalGrad = ctx.createLinearGradient(x - 5, 0, x + 5, 0);
        metalGrad.addColorStop(0, '#94a3b8');
        metalGrad.addColorStop(0.5, '#f1f5f9');
        metalGrad.addColorStop(1, '#475569');
        ctx.fillStyle = metalGrad;
        ctx.fillRect(x - 4, y - 20, 8, height + 20);
        
        // Khớp nối (Clamp)
        ctx.fillStyle = '#334155';
        ctx.beginPath();
        ctx.roundRect(x - 8, y - 5, 16, 15, 2);
        ctx.fill();
      };

      drawStand(startX, startY, 250);
      drawStand(horizontalEndX, inclineEndY, 150);

      // 2. Vẽ máng (Track) với hiệu ứng 3D kim loại
      const trackWidth = 12;
      const trackGrad = ctx.createLinearGradient(0, 0, 0, trackWidth); // Sẽ dùng translate/rotate
      
      const drawTrackSegment = (x1: number, y1: number, x2: number, y2: number, angle: number) => {
        ctx.save();
        ctx.translate(x1, y1);
        ctx.rotate(angle);
        
        // Bóng đổ dưới máng
        ctx.shadowColor = 'rgba(0,0,0,0.1)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetY = 4;

        const segGrad = ctx.createLinearGradient(0, 0, 0, trackWidth);
        segGrad.addColorStop(0, '#475569');
        segGrad.addColorStop(0.3, '#cbd5e1');
        segGrad.addColorStop(0.5, '#f1f5f9');
        segGrad.addColorStop(0.7, '#cbd5e1');
        segGrad.addColorStop(1, '#1e293b');
        
        ctx.fillStyle = segGrad;
        const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
        ctx.fillRect(0, -trackWidth/2, len, trackWidth);
        
        // Viền máng
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, -trackWidth/2, len, trackWidth);
        
        ctx.restore();
      };

      drawTrackSegment(startX, startY, inclineEndX, inclineEndY, angleRad);
      drawTrackSegment(inclineEndX, inclineEndY, horizontalEndX, inclineEndY, 0);

      // 3. Vẽ thước đo (Ruler) chuyên nghiệp
      ctx.save();
      const rulerY = inclineEndY + 25;
      const rulerHeight = 22;
      
      // Thân thước gỗ/nhựa cao cấp
      const rulerGrad = ctx.createLinearGradient(0, rulerY, 0, rulerY + rulerHeight);
      rulerGrad.addColorStop(0, '#fef3c7');
      rulerGrad.addColorStop(0.5, '#fcd34d');
      rulerGrad.addColorStop(1, '#f59e0b');
      ctx.fillStyle = rulerGrad;
      ctx.beginPath();
      ctx.roundRect(inclineEndX, rulerY, horizontalEndX - inclineEndX, rulerHeight, 2);
      ctx.fill();
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Vạch chia thước
      ctx.fillStyle = '#451a03';
      ctx.textAlign = 'center';
      for (let i = 0; i <= 100; i++) {
        const x = inclineEndX + (i / 100) * PIXELS_PER_METER;
        if (x > horizontalEndX) break;
        const h = i % 10 === 0 ? 12 : (i % 5 === 0 ? 8 : 4);
        ctx.fillRect(x, rulerY, 0.8, h);
        if (i % 10 === 0) {
          ctx.font = 'bold 9px Inter';
          ctx.fillText(i.toString(), x, rulerY + rulerHeight - 2);
        }
      }
      ctx.restore();

      // 4. Vẽ Cổng quang A (Photogate) thiết kế hiện đại
      const drawGate = (pos: number, isBlocking: boolean, label: string) => {
        let x, y;
        if (pos < INCLINE_LENGTH) {
          x = startX + pos * PIXELS_PER_METER * Math.cos(angleRad);
          y = startY + pos * PIXELS_PER_METER * Math.sin(angleRad);
        } else {
          x = inclineEndX + (pos - INCLINE_LENGTH) * PIXELS_PER_METER;
          y = inclineEndY;
        }

        ctx.save();
        ctx.translate(x, y);
        
        // Vỏ cổng quang (U-shape)
        ctx.fillStyle = '#1e293b';
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 5;
        
        // Thân chính
        ctx.beginPath();
        ctx.roundRect(-12, -65, 24, 75, 3);
        ctx.fill();
        
        // Khe hở (U)
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(-6, -50, 12, 45);
        
        // Đèn LED trạng thái
        ctx.fillStyle = isBlocking ? '#ef4444' : '#22c55e';
        ctx.shadowColor = isBlocking ? 'rgba(239, 68, 68, 0.8)' : 'rgba(34, 197, 94, 0.8)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(0, -58, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Tia hồng ngoại (chỉ vẽ khi không bị chắn hoặc vẽ mờ)
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = isBlocking ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -45);
        ctx.lineTo(0, -5);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Nhãn cổng
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(label, 0, -30);
        
        ctx.restore();
      };

      drawGate(INCLINE_LENGTH + gateAPos, isBlockingA, 'A');
      
      // 5. Vẽ Viên bi (Red Ball) với độ bóng cao
      if (isBallOnTrack) {
        let ballX, ballY, centerX, centerY;
        const ballRadiusPx = (avgDiameter / 2000) * PIXELS_PER_METER;
        const offset = (trackWidth / 2) + ballRadiusPx;

        if (ballPos < INCLINE_LENGTH) {
          ballX = startX + ballPos * PIXELS_PER_METER * Math.cos(angleRad);
          ballY = startY + ballPos * PIXELS_PER_METER * Math.sin(angleRad);
          centerX = ballX + offset * Math.sin(angleRad);
          centerY = ballY - offset * Math.cos(angleRad);
        } else {
          ballX = inclineEndX + (ballPos - INCLINE_LENGTH) * PIXELS_PER_METER;
          ballY = inclineEndY;
          centerX = ballX;
          centerY = ballY - offset;
        }
        
        ctx.save();
        // Bóng đổ của bi
        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 3;
        
        const grad = ctx.createRadialGradient(centerX - ballRadiusPx/3, centerY - ballRadiusPx/3, ballRadiusPx/10, centerX, centerY, ballRadiusPx);
        grad.addColorStop(0, '#ff8888');
        grad.addColorStop(0.7, '#cc0000');
        grad.addColorStop(1, '#660000');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, ballRadiusPx, 0, Math.PI * 2);
        ctx.fill();
        
        // Phản xạ ánh sáng (Highlight)
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.arc(centerX - ballRadiusPx/2.5, centerY - ballRadiusPx/2.5, ballRadiusPx/4, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.restore();
      }
    };

    draw();
  }, [ballPos, avgDiameter, isBlockingA, trackAngle, gateAPos, isBallOnTrack]);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-200">
              <Activity className="text-white" size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Thí nghiệm Đo tốc độ tức thời</h1>
              <p className="text-sm text-slate-500 font-medium">Vật lý 10 • Bài 6: Thực hành đo tốc độ của vật chuyển động</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setShowGuide(!showGuide)}
              className="p-3 rounded-2xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
              title="Hướng dẫn"
            >
              <HelpCircle size={20} />
            </button>
            <div className="h-10 w-px bg-slate-200 mx-2"></div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Thời gian hệ thống</span>
              <span className="font-mono font-bold text-red-600 text-lg">{currentTime.toFixed(3)}s</span>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Cột trái: Mô phỏng & Điều khiển */}
          <div className="lg:col-span-8 space-y-8">
            <Card className="overflow-hidden border-none shadow-xl shadow-slate-200/50">
              <div className="p-0 bg-white relative">
                <div className="absolute top-6 left-6 z-10 flex gap-3">
                  <div className="px-4 py-2 bg-white/90 backdrop-blur shadow-sm rounded-xl border border-slate-200 flex items-center gap-3">
                    <Timer size={16} className="text-red-600" />
                    <span className="font-mono font-bold text-slate-700">{currentTime.toFixed(3)}s</span>
                  </div>
                  <div className="px-4 py-2 bg-white/90 backdrop-blur shadow-sm rounded-xl border border-slate-200 flex items-center gap-3">
                    <Activity size={16} className="text-blue-600" />
                    <span className="text-[10px] font-bold text-slate-400 uppercase mr-1">Cổng A:</span>
                    <span className="font-mono font-bold text-slate-700">{tA !== null ? tA.toFixed(4) : "0.0000"}s</span>
                  </div>
                </div>

                <canvas 
                  ref={canvasRef} 
                  width={800} 
                  height={320} 
                  className="w-full h-auto bg-slate-50"
                />

                <div className="p-8 bg-white border-t border-slate-100">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-6">
                      <div className="space-y-3">
                        <div className="flex justify-between">
                          <label className="text-xs font-bold text-slate-500 uppercase tracking-widest">Góc nghiêng máng (α)</label>
                          <span className="text-sm font-bold text-red-600">{trackAngle}°</span>
                        </div>
                        <input 
                          type="range" min="5" max="60" step="1" 
                          value={trackAngle} 
                          onChange={(e) => setTrackAngle(Number(e.target.value))}
                          disabled={isSimulating}
                          className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-red-600"
                        />
                      </div>
                      <div className="space-y-3">
                        <div className="flex justify-between">
                          <label className="text-xs font-bold text-slate-500 uppercase tracking-widest">Vị trí cổng A (cm)</label>
                          <span className="text-sm font-bold text-blue-600">{Math.round(gateAPos * 100)} cm</span>
                        </div>
                        <input 
                          type="range" min="10" max="100" step="1" 
                          value={gateAPos * 100} 
                          onChange={(e) => setGateAPos(Number(e.target.value) / 100)}
                          disabled={isSimulating}
                          className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col justify-end gap-4">
                      <div className="flex gap-3">
                        <button 
                          onClick={() => setIsBallOnTrack(true)}
                          className={`flex-1 py-3 rounded-2xl font-bold text-sm transition-all ${isBallOnTrack ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                        >
                          Đặt bi vào
                        </button>
                        <button 
                          onClick={() => setIsBallOnTrack(false)}
                          className={`flex-1 py-3 rounded-2xl font-bold text-sm transition-all ${!isBallOnTrack ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                        >
                          Lấy bi ra
                        </button>
                      </div>
                      <div className="flex gap-3">
                        <button 
                          onClick={handleReset}
                          className="p-4 rounded-2xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all"
                        >
                          <RotateCcw size={20} />
                        </button>
                        <button 
                          onClick={handleStart}
                          disabled={isSimulating || !isBallOnTrack}
                          className={`flex-1 py-4 rounded-2xl font-bold text-lg transition-all shadow-lg ${isSimulating || !isBallOnTrack ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-red-600 text-white hover:bg-red-700 shadow-red-200'}`}
                        >
                          {isSimulating ? "Đang chạy..." : "BẮT ĐẦU"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            {/* Vùng đo đường kính */}
            <Card className="p-8 space-y-8 shadow-xl shadow-slate-200/50 border-none">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg text-red-600">
                  <Ruler size={20} />
                </div>
                <h2 className="text-xl font-bold text-slate-800">Đo đường kính viên bi (d)</h2>
              </div>
              
              <div className="space-y-8">
                <div className="relative bg-slate-50 rounded-2xl p-4 flex items-center justify-center border border-slate-100">
                  <canvas 
                    ref={caliperCanvasRef} 
                    width={600} 
                    height={200} 
                    className="max-w-full h-auto cursor-grab active:cursor-grabbing"
                  />
                  <div className="absolute top-4 right-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Dùng chuột kéo thước kẹp để đo</div>
                  <AnimatePresence>
                    {showCaliperHint && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-white border border-slate-200 rounded-full shadow-lg text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2"
                      >
                        <Info size={12} className="text-red-500" />
                        Kéo phần thước động để kẹp sát viên bi
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="flex flex-col md:flex-row items-center gap-6 bg-slate-50 rounded-2xl p-6 border border-slate-100">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-slate-800">Nhập kết quả đo</h3>
                      <button 
                        onClick={() => setShowCaliperGuide(true)}
                        className="text-[10px] font-bold text-red-600 hover:text-red-700 underline uppercase tracking-wider"
                      >
                        Hướng dẫn đọc thước
                      </button>
                    </div>
                    <p className="text-xs text-slate-500">Đọc giá trị trên thước kẹp và nhập vào ô bên dưới (mm)</p>
                  </div>
                  <div className="flex gap-3 w-full md:w-auto">
                    <input 
                      type="number" 
                      step="0.05"
                      placeholder="VD: 18.05"
                      value={userCaliperInput}
                      onChange={(e) => setUserCaliperInput(e.target.value)}
                      className="flex-1 md:w-32 px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none font-mono font-bold"
                    />
                    <button 
                      onClick={addDiameterMeasurement}
                      className="px-6 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-md shadow-red-200"
                    >
                      Ghi nhận
                    </button>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* Cột phải: Kết quả & Bảng số liệu */}
          <div className="lg:col-span-4 space-y-8">
            <Card className="bg-slate-900 text-white overflow-hidden">
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-red-400">Kết quả tính toán</h3>
                  <Activity size={16} className="text-slate-500" />
                </div>
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/10 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-2 opacity-10">
                      <Timer size={48} />
                    </div>
                    <span className="text-[10px] uppercase text-slate-500 font-bold block mb-2">Vận tốc tức thời tại A</span>
                    <div className="text-3xl font-mono text-blue-400 font-bold leading-tight">
                      {vA_cm_s > 0 ? (
                        <>
                          <span className="overline">v</span> = {vA_cm_s.toFixed(2)} ± {deltaV.toFixed(2)}
                          <span className="text-sm font-normal ml-2">cm/s</span>
                        </>
                      ) : (
                        <span className="text-slate-600">Đang chờ dữ liệu...</span>
                      )}
                    </div>
                    <div className="mt-4 pt-4 border-t border-white/5 flex flex-col gap-1">
                      <span className="text-[10px] text-slate-400">Công thức: <span className="text-red-400 font-mono"><span className="overline">v</span> = <span className="overline">d</span> / <span className="overline">t</span></span></span>
                      <span className="text-[10px] text-slate-400">Sai số: <span className="text-red-400 font-mono">Δv = <span className="overline">v</span> · (Δd/<span className="overline">d</span> + Δt/<span className="overline">t</span>)</span></span>
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <div className="space-y-8">
              {/* Bảng 6.1 */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-slate-700 font-bold text-sm">
                  <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[10px] border-t-slate-700"></div>
                  <span className="uppercase tracking-tight">Bảng 6.1. Bảng kết quả đo đường kính viên bi</span>
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-300 shadow-sm">
                  <table className="w-full text-center text-[10px] border-collapse">
                    <thead>
                      <tr className="bg-slate-600 text-white">
                        <th rowSpan={2} className="border border-slate-400 p-3 font-bold w-32"></th>
                        <th colSpan={5} className="border border-slate-400 p-2 font-bold uppercase tracking-wider">Lần đo</th>
                        <th rowSpan={2} className="border border-slate-400 p-2 font-bold leading-tight">Đường kính trung bình <br/> <span className="overline">d</span> (cm)</th>
                        <th rowSpan={2} className="border border-slate-400 p-2 font-bold leading-tight">Sai số <br/> Δ<span className="italic">d</span> (cm)</th>
                      </tr>
                      <tr className="bg-slate-500 text-white">
                        {[1, 2, 3, 4, 5].map(i => (
                          <th key={i} className="border border-slate-400 p-2 font-bold">Lần {i}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="bg-white">
                        <td className="border border-slate-300 p-4 font-bold text-slate-800 bg-slate-100 leading-tight">
                          Đường kính <br/> <span className="italic text-xs font-serif">d</span> (cm)
                        </td>
                        {[0, 1, 2, 3, 4].map(i => (
                          <td key={i} className="border border-slate-300 p-4 font-mono text-slate-700 text-sm">
                            {diameterMeasurements[i] ? (diameterMeasurements[i].value / 10).toFixed(2) : "—"}
                          </td>
                        ))}
                        <td className="border border-slate-300 p-4 font-mono font-bold text-slate-900 bg-slate-50 text-sm">
                          {statsDiameter.avg > 0 ? statsDiameter.avg.toFixed(3) : "—"}
                        </td>
                        <td className="border border-slate-300 p-4 font-mono text-slate-700 bg-slate-50 text-[10px] leading-tight">
                          {statsDiameter.avg > 0 ? (
                            <>
                              Δd = <span className="overline">Δd</span> + Δd<sub>dc</sub> <br/>
                              = {statsDiameter.avgDeltaD.toFixed(3)} + 0.005 <br/>
                              = <span className="font-bold text-slate-900">{statsDiameter.error.toFixed(3)}</span>
                            </>
                          ) : "—"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bảng 6.2 */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-slate-700 font-bold text-sm">
                  <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[10px] border-t-slate-700"></div>
                  <span className="uppercase tracking-tight">Bảng 6.2. Bảng kết quả đo tốc độ tức thời của viên bi</span>
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-300 shadow-sm">
                  <table className="w-full text-center text-[10px] border-collapse">
                    <thead>
                      <tr className="bg-slate-600 text-white">
                        <th rowSpan={2} className="border border-slate-400 p-3 font-bold w-32"></th>
                        <th colSpan={5} className="border border-slate-400 p-2 font-bold uppercase tracking-wider">Lần đo</th>
                        <th rowSpan={2} className="border border-slate-400 p-2 font-bold leading-tight">Thời gian trung bình <br/> <span className="overline">t</span> (s)</th>
                        <th rowSpan={2} className="border border-slate-400 p-2 font-bold leading-tight">Sai số <br/> Δ<span className="italic text-xs">t</span> (s)</th>
                        <th rowSpan={2} className="border border-slate-400 p-2 font-bold leading-tight">Tốc độ tức thời <br/> <span className="overline">v</span> = <span className="overline">d</span>/<span className="overline">t</span> (cm/s)</th>
                        <th rowSpan={2} className="border border-slate-400 p-2 font-bold leading-tight">Sai số <br/> Δ<span className="italic text-xs">v</span> (cm/s)</th>
                      </tr>
                      <tr className="bg-slate-500 text-white">
                        {[1, 2, 3, 4, 5].map(i => (
                          <th key={i} className="border border-slate-400 p-2 font-bold">Lần {i}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="bg-white">
                        <td className="border border-slate-300 p-4 font-bold text-slate-800 bg-slate-100 leading-tight">
                          Thời gian <br/> <span className="italic text-xs font-serif">t</span> (s)
                        </td>
                        {[0, 1, 2, 3, 4].map(i => (
                          <td key={i} className="border border-slate-300 p-4 font-mono text-slate-700 text-sm">
                            {measurements[i] ? measurements[i].tA.toFixed(4) : "—"}
                          </td>
                        ))}
                        <td className="border border-slate-300 p-4 font-mono font-bold text-slate-900 bg-slate-50 text-sm">
                          {statsTime.avg > 0 ? statsTime.avg.toFixed(4) : "—"}
                        </td>
                        <td className="border border-slate-300 p-4 font-mono text-slate-700 bg-slate-50 text-[10px] leading-tight">
                          {statsTime.avg > 0 ? (
                            <>
                              Δt = <span className="overline">Δt</span> + Δt<sub>dc</sub> <br/>
                              = {statsTime.avgDeltaT.toFixed(4)} + 0.0005 <br/>
                              = <span className="font-bold text-slate-900">{statsTime.error.toFixed(4)}</span>
                            </>
                          ) : "—"}
                        </td>
                        <td className="border border-slate-300 p-4 font-mono font-bold text-slate-900 bg-slate-50 text-sm">
                          {vA_cm_s > 0 ? vA_cm_s.toFixed(2) : "—"}
                        </td>
                        <td className="border border-slate-300 p-4 font-mono text-slate-700 bg-slate-50 text-[10px] leading-tight">
                          {deltaV > 0 ? (
                            <>
                              Δv = <span className="overline">v</span> · (Δd/<span className="overline">d</span> + Δt/<span className="overline">t</span>) <br/>
                              = <span className="font-bold text-slate-900">{deltaV.toFixed(2)}</span>
                            </>
                          ) : "—"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Guide Modal */}
      <AnimatePresence>
        {showGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowGuide(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-2xl rounded-[32px] shadow-2xl overflow-hidden"
            >
              <div className="p-8 space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-bold tracking-tight">Hướng dẫn thí nghiệm</h2>
                  <button onClick={() => setShowGuide(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center text-red-600">
                      <Ruler size={20} />
                    </div>
                    <h3 className="font-bold">Bước 1: Đo đường kính</h3>
                    <p className="text-sm text-slate-500">Sử dụng thước kẹp để đo đường kính viên bi 5 lần. Nhập kết quả vào bảng để tính sai số.</p>
                  </div>
                  <div className="space-y-3">
                    <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600">
                      <Play size={20} />
                    </div>
                    <h3 className="font-bold">Bước 2: Đo thời gian</h3>
                    <p className="text-sm text-slate-500">Điều chỉnh góc nghiêng và vị trí cổng quang. Nhấn Bắt đầu để bi lăn qua cổng A và ghi lại thời gian.</p>
                  </div>
                </div>

                <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Lưu ý</h4>
                  <ul className="space-y-2">
                    {[
                      "Đảm bảo bi được đặt sát thanh chắn trước khi thả.",
                      "Đọc giá trị trên thước kẹp chính xác đến 0.05mm.",
                      "Thực hiện đủ 5 lần đo cho mỗi đại lượng để có kết quả chính xác."
                    ].map((text, i) => (
                      <li key={i} className="flex items-start gap-3 text-sm text-slate-600">
                        <CheckCircle2 size={18} className="text-red-500 shrink-0 mt-0.5" />
                        <span>{text}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button 
                  onClick={() => setShowGuide(false)}
                  className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all"
                >
                  Đã hiểu, bắt đầu thí nghiệm
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Caliper Guide Modal */}
      <AnimatePresence>
        {showCaliperGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowCaliperGuide(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-2xl rounded-[32px] shadow-2xl overflow-hidden"
            >
              <div className="p-8 space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-2xl font-bold text-slate-900">Cách đọc thước kẹp Vernier (0.05mm)</h3>
                  <button onClick={() => setShowCaliperGuide(false)} className="p-2 hover:bg-slate-100 rounded-full">
                    <X size={24} />
                  </button>
                </div>
                
                <div className="grid md:grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <div className="bg-red-50 p-4 rounded-2xl border border-red-100">
                      <div className="text-red-600 font-bold text-sm uppercase mb-1">Bước 1: Đọc phần nguyên</div>
                      <p className="text-slate-600 text-sm">Nhìn vào vạch số <b>0 của du xích</b>. Vạch này nằm sau vạch nào trên thân thước chính thì đó là số mm nguyên.</p>
                    </div>
                    <div className="bg-blue-50 p-4 rounded-2xl border border-blue-100">
                      <div className="text-blue-600 font-bold text-sm uppercase mb-1">Bước 2: Đọc phần thập phân</div>
                      <p className="text-slate-600 text-sm">Tìm vạch trên <b>du xích</b> trùng khít nhất với một vạch bất kỳ trên thân thước chính.</p>
                    </div>
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
                      <div className="text-slate-600 font-bold text-sm uppercase mb-1">Bước 3: Tính toán</div>
                      <p className="text-slate-600 text-sm">Giá trị = Phần nguyên + (Số thứ tự vạch trùng × 0.05).</p>
                    </div>
                  </div>
                  
                  <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 flex flex-col justify-center items-center text-center space-y-4">
                    <div className="text-4xl font-mono font-bold text-slate-900">18.00 <span className="text-lg text-slate-400">mm</span></div>
                    <p className="text-xs text-slate-500 italic">Ví dụ: Vạch 0 của du xích trùng với vạch 18 trên thước chính.</p>
                    <div className="w-full h-px bg-slate-200" />
                    <div className="text-sm text-slate-600">
                      <span className="font-bold text-red-600">Lưu ý:</span> Trong mô phỏng này, đèn <b>TOUCH</b> sẽ sáng xanh khi thước chạm sát bi.
                    </div>
                  </div>
                </div>
                
                <button 
                  onClick={() => setShowCaliperGuide(false)}
                  className="w-full py-4 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all"
                >
                  Đã hiểu, quay lại thí nghiệm
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Thành phần Card bổ trợ ---
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white p-6 rounded-3xl border border-slate-200 shadow-sm ${className}`}>
      {children}
    </div>
  );
}
