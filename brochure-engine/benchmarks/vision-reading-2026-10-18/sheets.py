from PIL import Image, ImageOps, ImageDraw
from pathlib import Path
import sys
root=Path(__file__).parent
first=int(sys.argv[1]) if len(sys.argv)>1 else 1
last=int(sys.argv[2]) if len(sys.argv)>2 else 65
for start in range(first,last,8):
    sheet=Image.new('RGB',(1600,1200),'#eeeeee')
    draw=ImageDraw.Draw(sheet)
    for n in range(start,start+8):
        image=Image.open(root/'images'/f'{n:02}.jpg').convert('RGB')
        x=((n-start)%4)*400; y=((n-start)//4)*600
        fitted=ImageOps.contain(image,(394,560))
        sheet.paste(fitted,(x+(400-fitted.width)//2,y+30+(560-fitted.height)//2))
        draw.text((x+10,y+8),f'{n} / original {image.width}x{image.height}',fill='black')
    sheet.save(root/f'sheet-{start:02}.jpg',quality=95)
for path in (root/'images').glob('*.jpg'):
    image=Image.open(path).convert('RGB')
    factor=min(2,1536/max(image.size))
    image.resize((round(image.width*factor),round(image.height*factor)),Image.Resampling.LANCZOS).save(path.with_name(path.stem+'-2x.png'))
