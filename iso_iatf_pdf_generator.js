/**
 * ════════════════════════════════════════════════════════════════
 * ISO/IATF JIG INSPECTION REPORT GENERATOR
 * ════════════════════════════════════════════════════════════════
 * 
 * Purpose: Generate professional ISO IATF-compliant inspection PDFs
 *          from JIG Dashboard inspection data
 * 
 * Integration: Add to app.js for exporting inspection reports
 * 
 * Usage: exportInspectionAsIsoIatfPdf(inspectionId)
 * 
 * Requirements:
 * - jsPDF (already included in app.js)
 * - html2canvas (already included in app.js)
 * ════════════════════════════════════════════════════════════════
 */

/**
 * Generate ISO IATF compliant PDF from inspection data
 * @param {Object} inspection - Inspection data object with:
 *   - id: Inspection ID
 *   - jigId: JIG ID/Part Number
 *   - jigName: JIG Name
 *   - dept: Department
 *   - line: Production Line
 *   - date: Inspection date (YYYY-MM-DD)
 *   - time: Inspection time (HH:MM)
 *   - shift: Shift (Morning/Afternoon/Night)
 *   - checkpoints: Array of inspection checkpoint objects
 *   - inspector: Inspector name
 *   - supervisor: Supervisor name
 */
function generateIsoIatfPdf(inspection) {
  const { jsPDF } = window.jspdf;
  
  // ─────────────────────────────────────────────────────────────
  // PAGE SETUP (A4 - 210 x 297 mm)
  // ─────────────────────────────────────────────────────────────
  
  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 10;
  
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });
  
  let yPos = margin;
  
  // Color scheme (ISO Standard colors)
  const colors = {
    darkBlue: [0, 51, 102],       // #003366
    lightBlue: [232, 238, 245],   // #E8EEF5
    darkGray: [50, 50, 50],       // #323232
    mediumGray: [100, 100, 100],  // #646464
    lightGray: [200, 200, 200],   // #C8C8C8
    pass: [46, 204, 113],         // #2ECC71 - Green
    fail: [231, 76, 60],          // #E74C3C - Red
    white: [255, 255, 255]
  };
  
  // ═════════════════════════════════════════════════════════════
  // SECTION 1: HEADER & DOCUMENT INFORMATION
  // ═════════════════════════════════════════════════════════════
  
  // Company Header
  doc.setFontSize(14);
  doc.setTextColor(...colors.darkBlue);
  doc.setFont('helvetica', 'bold');
  doc.text('SUMMIT AUTO BODY INDUSTRY CO., LTD.', pageWidth / 2, yPos, { align: 'center' });
  yPos += 6;
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...colors.mediumGray);
  doc.text('(Ayutthaya Branch)', pageWidth / 2, yPos, { align: 'center' });
  yPos += 8;
  
  // Report Title
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...colors.darkBlue);
  doc.text('JIG INSPECTION REPORT', pageWidth / 2, yPos, { align: 'center' });
  yPos += 6;
  
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...colors.mediumGray);
  doc.text('ISO 9001:2015 / IATF 16949:2016', pageWidth / 2, yPos, { align: 'center' });
  yPos += 10;
  
  // Document Info Box
  doc.setDrawColor(...colors.darkBlue);
  doc.setLineWidth(0.5);
  doc.rect(margin, yPos - 2, pageWidth - 2 * margin, 20);
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...colors.darkBlue);
  
  const docNo = `JIG-${inspection.jigId}-${inspection.date}`;
  doc.text(`Doc No: ${docNo}`, margin + 3, yPos + 3);
  doc.text('REV: 01', margin + 3, yPos + 8);
  doc.text(`Date: ${inspection.date}`, margin + 3, yPos + 13);
  
  doc.text(`Time: ${inspection.time || 'N/A'}`, pageWidth - margin - 40, yPos + 3);
  doc.text(`Shift: ${inspection.shift || 'N/A'}`, pageWidth - margin - 40, yPos + 8);
  doc.text('Page: 1/1', pageWidth - margin - 40, yPos + 13);
  
  yPos += 25;
  
  // ═════════════════════════════════════════════════════════════
  // SECTION 2: JIG IDENTIFICATION
  // ═════════════════════════════════════════════════════════════
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...colors.darkBlue);
  doc.text('1. JIG IDENTIFICATION', margin, yPos);
  yPos += 7;
  
  // Identification data
  const jigInfoData = [
    ['JIG ID / Part No.', inspection.jigId || 'N/A', 'JIG Name', inspection.jigName || 'N/A'],
    ['Department', inspection.dept || 'N/A', 'Production Line', inspection.line || 'N/A'],
    ['Location', inspection.location || 'N/A', 'Model', inspection.model || 'N/A'],
    ['Manufacture Date', inspection.mfgDate || 'N/A', 'Last Inspection', inspection.lastInspection || 'N/A']
  ];
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...colors.darkGray);
  
  jigInfoData.forEach((row) => {
    doc.text(`${row[0]}:`, margin + 2, yPos);
    doc.setFont('helvetica', 'bold');
    doc.text(row[1], margin + 45, yPos);
    doc.setFont('helvetica', 'normal');
    doc.text(`${row[2]}:`, pageWidth / 2 + 2, yPos);
    doc.setFont('helvetica', 'bold');
    doc.text(row[3], pageWidth / 2 + 45, yPos);
    yPos += 5;
  });
  
  yPos += 3;
  
  // ═════════════════════════════════════════════════════════════
  // SECTION 3: INSPECTION CHECKLIST TABLE
  // ═════════════════════════════════════════════════════════════
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...colors.darkBlue);
  doc.text('2. INSPECTION CHECKLIST', margin, yPos);
  yPos += 7;
  
  // Table configuration
  const colWidths = [12, 50, 30, 25, 33];  // No., Item, Criteria, Status, Remarks
  const tableWidth = colWidths.reduce((a, b) => a + b);
  const colPositions = [
    margin,
    margin + colWidths[0],
    margin + colWidths[0] + colWidths[1],
    margin + colWidths[0] + colWidths[1] + colWidths[2],
    margin + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3]
  ];
  
  // Table header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setFillColor(...colors.darkBlue);
  doc.setTextColor(...colors.white);
  
  const headers = ['No.', 'Inspection Item', 'Criteria', 'Status', 'Remarks'];
  const headerRowHeight = 6;
  
  headers.forEach((header, i) => {
    doc.rect(colPositions[i], yPos, colWidths[i], headerRowHeight, 'F');
    doc.text(header, colPositions[i] + 1, yPos + 4.5, { maxWidth: colWidths[i] - 2, align: 'left' });
  });
  
  yPos += headerRowHeight;
  
  // Table body - inspection checkpoints
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...colors.darkGray);
  
  if (!inspection.checkpoints || inspection.checkpoints.length === 0) {
    // Empty state
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(150, 150, 150);
    doc.text('No inspection items recorded', margin + 2, yPos + 4);
    yPos += 8;
  } else {
    // Render each checkpoint
    inspection.checkpoints.forEach((cp, idx) => {
      const rowHeight = 6;
      const itemNum = idx + 1;
      const status = cp.status || 'ไม่ระบุ';
      
      // Determine status color
      let statusBgColor = colors.lightGray;
      if (status === 'ผ่าน (OK)' || status === 'OK' || status === 'PASS') {
        statusBgColor = colors.pass;
      } else if (status === 'ไม่ผ่าน (NG)' || status === 'NG' || status === 'FAIL') {
        statusBgColor = colors.fail;
      }
      
      // Alternating row background
      if (idx % 2 === 0) {
        doc.setFillColor(245, 245, 245);
        doc.rect(margin, yPos, pageWidth - 2 * margin, rowHeight, 'F');
      }
      
      // Draw cell borders
      doc.setDrawColor(...colors.lightGray);
      doc.setLineWidth(0.2);
      for (let i = 0; i < colWidths.length; i++) {
        doc.rect(colPositions[i], yPos, colWidths[i], rowHeight);
      }
      
      // Cell content
      doc.setTextColor(...colors.darkGray);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      
      // No.
      doc.text(String(itemNum), colPositions[0] + 1, yPos + 4.5, { align: 'center' });
      
      // Inspection Item
      doc.text(cp.label || 'N/A', colPositions[1] + 1, yPos + 4.5, { maxWidth: colWidths[1] - 2 });
      
      // Criteria
      doc.text(cp.method || 'Visual', colPositions[2] + 1, yPos + 4.5, { maxWidth: colWidths[2] - 2 });
      
      // Status (with colored background)
      doc.setFillColor(...statusBgColor);
      doc.rect(colPositions[3], yPos, colWidths[3], rowHeight, 'F');
      doc.setTextColor(...colors.white);
      doc.setFont('helvetica', 'bold');
      doc.text(status, colPositions[3] + colWidths[3] / 2, yPos + 4.5, { align: 'center' });
      
      // Remarks
      doc.setTextColor(...colors.darkGray);
      doc.setFont('helvetica', 'normal');
      doc.text(cp.remarks || '-', colPositions[4] + 1, yPos + 4.5, { maxWidth: colWidths[4] - 2 });
      
      yPos += rowHeight;
      
      // Page break if needed
      if (yPos > pageHeight - 50) {
        doc.addPage();
        yPos = margin;
      }
    });
  }
  
  yPos += 5;
  
  // ═════════════════════════════════════════════════════════════
  // SECTION 4: OVERALL INSPECTION RESULT
  // ═════════════════════════════════════════════════════════════
  
  // Calculate overall result
  const allPass = !inspection.checkpoints || 
                  inspection.checkpoints.every(cp => 
                    cp.status === 'ผ่าน (OK)' || cp.status === 'OK' || cp.status === 'PASS'
                  );
  
  const overallStatus = allPass ? 'PASSED ✓' : 'FAILED ✗';
  const resultColor = allPass ? colors.pass : colors.fail;
  
  doc.setFillColor(...resultColor);
  doc.setTextColor(...colors.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.rect(margin, yPos, pageWidth - 2 * margin, 10, 'F');
  doc.text(`INSPECTION RESULT: ${overallStatus}`, pageWidth / 2, yPos + 6.5, { align: 'center' });
  
  yPos += 15;
  
  // ═════════════════════════════════════════════════════════════
  // SECTION 5: SIGNATURE & APPROVAL
  // ═════════════════════════════════════════════════════════════
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...colors.darkBlue);
  doc.text('3. APPROVAL & SIGNATURE', margin, yPos);
  yPos += 8;
  
  // Signature layout
  const sigBoxWidth = (pageWidth - 3 * margin) / 2;
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...colors.darkGray);
  
  // Inspector signature
  doc.text('Inspected by:', margin + 2, yPos);
  doc.setDrawColor(...colors.mediumGray);
  doc.setLineWidth(0.3);
  doc.line(margin + 2, yPos + 8, margin + sigBoxWidth - 2, yPos + 8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(150, 150, 150);
  doc.text(inspection.inspector || '(Name & Signature)', margin + 2, yPos + 10, { maxWidth: sigBoxWidth - 4 });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.setFontSize(7);
  doc.text('Date: ___/___/_____', margin + 2, yPos + 15);
  
  // Supervisor signature
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...colors.darkGray);
  doc.text('Approved by:', margin + sigBoxWidth + 2, yPos);
  doc.setDrawColor(...colors.mediumGray);
  doc.setLineWidth(0.3);
  doc.line(margin + sigBoxWidth + 2, yPos + 8, pageWidth - margin - 2, yPos + 8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(150, 150, 150);
  doc.text(inspection.supervisor || '(Supervisor Signature)', margin + sigBoxWidth + 2, yPos + 10, { maxWidth: sigBoxWidth - 4 });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.setFontSize(7);
  doc.text('Date: ___/___/_____', margin + sigBoxWidth + 2, yPos + 15);
  
  yPos += 20;
  
  // ═════════════════════════════════════════════════════════════
  // FOOTER: DOCUMENT CONTROL
  // ═════════════════════════════════════════════════════════════
  
  doc.setDrawColor(...colors.darkBlue);
  doc.setLineWidth(0.5);
  doc.line(margin, pageHeight - margin - 8, pageWidth - margin, pageHeight - margin - 8);
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(100, 100, 100);
  
  const generatedTime = new Date().toLocaleString('th-TH', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  doc.text(`Generated: ${generatedTime} | Version: 1.0 | ISO 9001:2015 | IATF 16949:2016`, pageWidth / 2, pageHeight - margin - 4, { align: 'center' });
  
  // ═════════════════════════════════════════════════════════════
  // SAVE PDF
  // ═════════════════════════════════════════════════════════════
  
  const filename = `JIG_Inspection_${inspection.jigId}_${inspection.date}.pdf`;
  doc.save(filename);
  
  return filename;
}

/**
 * Export inspection from JIG Dashboard as ISO IATF PDF
 * Call this function from your inspection history panel
 * 
 * @param {string} inspectionId - The inspection ID to export
 */
function exportInspectionAsIsoIatfPdf(inspectionId) {
  // Load inspection from history
  const inspection = loadHistory().find(h => h.id === inspectionId);
  
  if (!inspection) {
    toast('ไม่พบรายการตรวจสอบ', 'ng');
    return;
  }
  
  toast('กำลังสร้าง ISO IATF Report...', 'ok');
  
  setTimeout(() => {
    try {
      generateIsoIatfPdf(inspection);
      toast('✓ สร้าง Report สำเร็จ!', 'ok');
    } catch (e) {
      console.error('PDF generation error:', e);
      toast('✗ สร้าง Report ล้มเหลว: ' + (e.message || e), 'ng');
    }
  }, 500);
}

/**
 * Batch export multiple inspections as PDF
 * 
 * @param {string[]} inspectionIds - Array of inspection IDs to export
 */
function batchExportAsIsoIatfPdf(inspectionIds) {
  if (!inspectionIds || inspectionIds.length === 0) {
    toast('ไม่มีรายการที่เลือก', 'ng');
    return;
  }
  
  toast(`กำลังสร้าง Report ${inspectionIds.length} ไฟล์...`, 'ok');
  
  inspectionIds.forEach((id, idx) => {
    setTimeout(() => {
      try {
        const inspection = loadHistory().find(h => h.id === id);
        if (inspection) {
          generateIsoIatfPdf(inspection);
          if (idx === inspectionIds.length - 1) {
            toast(`✓ สร้าง Report ${inspectionIds.length} ไฟล์สำเร็จ!`, 'ok');
          }
        }
      } catch (e) {
        console.error(`Export ${id} failed:`, e);
      }
    }, idx * 500);  // Stagger exports to prevent blocking
  });
}

// ════════════════════════════════════════════════════════════════
// END OF ISO IATF PDF GENERATOR
// ════════════════════════════════════════════════════════════════
