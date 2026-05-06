import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // For images, return base64 for vision processing
    if (file.type.startsWith('image/')) {
      const base64 = buffer.toString('base64');
      return NextResponse.json({
        text: null,
        imageBase64: base64,
        imageType: file.type,
        isImage: true,
        fileName: file.name,
      });
    }

    // For PDFs
    if (file.type === 'application/pdf') {
      try {
        // Use dynamic import to avoid build issues
        const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
        const data = await pdfParse(buffer);
        return NextResponse.json({
          text: data.text,
          pages: data.numpages,
          fileName: file.name,
          isImage: false,
        });
      } catch (pdfError) {
        console.error('PDF parse error:', pdfError);
        return NextResponse.json({
          text: buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' '),
          fileName: file.name,
          isImage: false,
          parseError: true,
        });
      }
    }

    // For text files
    return NextResponse.json({
      text: buffer.toString('utf-8'),
      fileName: file.name,
      isImage: false,
    });

  } catch (error) {
    console.error('Parse error:', error);
    return NextResponse.json({ error: 'Failed to parse file' }, { status: 500 });
  }
}
