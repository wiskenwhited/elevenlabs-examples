import express, { Request, Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { Llm } from '~/llm';
import { Stream } from '~/stream';
import { TextToSpeech } from '~/text-to-speech';

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '5000');

export const startApp = () => {
  app.post('/incoming', (req: Request, res: Response) => {
    const twiml = new VoiceResponse();

    twiml.connect().stream({
      url: `wss://${process.env.SERVER_DOMAIN}/connection`,
    });

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  });

  app.ws('/connection', (ws: WebSocket) => {
    console.log('Twilio -> Connection opened'.underline.green);

    ws.on('error', console.error);

    const sttWs = new WebSocket(
      `${process.env.ELEVENLABS_ALPHA_BASE_URL!.replace(
        'http',
        'ws',
      )}/speech-to-text/connect`,
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'xi-encoding': 'mulaw',
          'xi-sample-rate': '8000',
        },
      },
    );

    let sttWsIsOpen = false;

    sttWs.on('open', () => {
      console.log('------------------');
      console.log('OPEN STT');
      console.log('------------------');
      sttWsIsOpen = true;
    });

    sttWs.on('close', (code, reason) => {
      console.log(
        `STT -> Connection closed: ${code} - ${reason}`.underline.red,
      );
    });

    sttWs.on('error', console.error);

    sttWs.on('message', (data) => {
      const message: { event: string; data: string } = JSON.parse(
        data.toString(),
      );

      if (message.event === 'transcription') {
        console.log(
          `Interaction ${interactionCount} – STT -> LLM: ${message.data}`
            .yellow,
        );
        llm.completion(message.data, interactionCount);
        interactionCount += 1;
      }

      if (message.event === 'utterance') {
        if (marks.length > 0 && message.data?.length > 5) {
          console.log('Twilio -> Interruption, Clearing stream'.red);
          ws.send(
            JSON.stringify({
              streamSid,
              event: 'clear',
            }),
          );
        }
      }
    });

    const llm = new Llm();
    const stream = new Stream(ws);
    const textToSpeech = new TextToSpeech();

    let streamSid: string;
    let callSid: string;
    let marks: string[] = [];
    let interactionCount: number = 0;

    // Incoming from MediaStream
    ws.on('message', (data: string) => {
      const message: {
        event: string;
        start?: { streamSid: string; callSid: string };
        media?: { payload: string };
        mark?: { name: string };
        sequenceNumber?: number;
      } = JSON.parse(data);

      if (message.event === 'start' && message.start) {
        streamSid = message.start.streamSid;
        callSid = message.start.callSid;
        stream.setStreamSid(streamSid);
        llm.setCallSid(callSid);
        console.log(
          `Twilio -> Starting Media Stream for ${streamSid}`.underline.red,
        );
        textToSpeech.generate(
          {
            partialResponseIndex: null,
            partialResponse: 'Hi, my name is Eleven. How can I help you?',
          },
          1,
        );
      } else if (message.event === 'media' && message.media) {
        if (sttWsIsOpen) {
          sttWs.send(
            JSON.stringify({ event: 'audio', data: message.media.payload }),
          );
        }
      } else if (message.event === 'mark' && message.mark) {
        const label: string = message.mark.name;

        console.log(
          `Twilio -> Audio completed mark (${message.sequenceNumber}): ${label}`
            .red,
        );

        marks = marks.filter((m: string) => m !== message.mark?.name);
      } else if (message.event === 'stop') {
        console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
      }
    });

    llm.on(
      'llmreply',
      async (llmReply: { partialResponse: string }, icount: number) => {
        console.log(
          `Interaction ${icount}: LLM -> TTS: ${llmReply.partialResponse}`
            .green,
        );
        textToSpeech.generate(llmReply, icount);
      },
    );

    textToSpeech.on(
      'speech',
      (responseIndex: number, audio: string, label: string, icount: number) => {
        console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);

        stream.buffer(responseIndex, audio);
      },
    );

    stream.on('audiosent', (markLabel: string) => {
      marks.push(markLabel);
    });
  });

  app.listen(PORT, () => {
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`Remote: https://${process.env.SERVER_DOMAIN}`);
  });
};