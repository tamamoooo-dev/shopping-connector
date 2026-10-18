from PIL import Image, ImageOps, ImageDraw
from pathlib import Path
root=Path(__file__).parent
for start in range(1,89,8):
    sheet=Image.new('RGB',(1600,1200),'#eeeeee');draw=ImageDraw.Draw(sheet)
    for n in range(start,min(start+8,89)):
        image=Image.open(root/'images'/f'{n}.jpg').convert('RGB')
        x=((n-start)%4)*400;y=((n-start)//4)*600
        fitted=ImageOps.contain(image,(394,560));sheet.paste(fitted,(x+(400-fitted.width)//2,y+30+(560-fitted.height)//2))
        draw.text((x+10,y+8),str(n),fill='black')
    sheet.save(root/f'sheet-{start}.jpg',quality=95)
