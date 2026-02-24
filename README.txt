Como subir update a GitHub

git status

1) Agregar los archivos al commit
CMD: git add .
2) Hacer el commit
CMD: git commit -m "Version Update - Aqui se escriben los cambios que tubo la version nueva"
3) Subir a GitHub
CMD: git push
4) Crear el tag (esto dispara el workflow de GitHub Actions)
git tag v1.0.10
git push origin v1.0.10

Si ya existía el tag v1.x.x (y te da error)

Entonces sube un patch:

cambia versión a 1.0.x+ en package.json

commit + push

tag v1.0.7

